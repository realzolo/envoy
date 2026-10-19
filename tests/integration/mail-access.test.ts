import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, query } from "@/platform/database";
import { persistInbound, ingestProviderWebhook, getInboundMessage, listInboundMessages } from "@/modules/inbound/public";
import { processRawProviderEvent } from "@/modules/outbound/public";
import { providerRegistry } from "@/integrations/providers/registry";
import { setDomainInboundSources } from "@/modules/channels/public";

const tag = crypto.randomUUID().replaceAll("-", "");
const domain = `access-${tag}.test`;
const otherDomain = `other-${tag}.test`;
const domainId = `sd_${tag}`;
const otherDomainId = `sd_other_${tag}`;
const services = [`svc_a_${tag}`, `svc_b_${tag}`, `svc_c_${tag}`];
const externalIds: string[] = [];
const rawIds: string[] = [];

function message(envelopeRecipients?: string[]) {
  const externalMessageId = crypto.randomUUID();
  externalIds.push(externalMessageId);
  return {
    externalMessageId,
    from: "author@example.net",
    to: [`visible@${domain}`],
    cc: [],
    bcc: [`private@${otherDomain}`],
    envelopeRecipients,
    subject: "Bound domain delivery",
    text: "Private content",
    attachments: [],
    receivedAt: new Date(),
  };
}

async function deliver(envelopeRecipients?: string[], webhookEndpointId = "pwe_mock") {
  const received = message(envelopeRecipients);
  await persistInbound({ providerAccountId: "pa_mock", webhookEndpointId, rawEventId: null!, message: received });
  return received.externalMessageId;
}

beforeAll(async () => {
  for (const serviceId of services) await query("INSERT INTO services(id,name) VALUES($1,$1)", [serviceId]);
  await query("INSERT INTO sending_domains(id,domain) VALUES($1,$2),($3,$4)", [domainId, domain, otherDomainId, otherDomain]);
  await query("INSERT INTO domain_inbound_sources(sending_domain_id,provider_account_id) VALUES($1,'pa_mock'),($2,'pa_mock')", [domainId, otherDomainId]);
  for (const [index, serviceId] of services.entries()) {
    await query("INSERT INTO service_domain_bindings(id,service_id,sending_domain_id,receive_enabled) VALUES($1,$2,$3,true)", [`sdb_${index}_${tag}`, serviceId, index === 2 ? otherDomainId : domainId]);
  }
});

afterAll(async () => {
  await query("DELETE FROM inbound_messages WHERE external_message_id=ANY($1)", [externalIds]);
  await query("DELETE FROM inbound_receipts WHERE external_message_id=ANY($1)", [externalIds]);
  await query("DELETE FROM outbox_events WHERE payload->>'rawEventId'=ANY($1)", [rawIds]);
  await query("DELETE FROM raw_provider_events WHERE id=ANY($1)", [rawIds]);
  await query("DELETE FROM services WHERE id=ANY($1)", [services]);
  await query("DELETE FROM sending_domains WHERE id=ANY($1)", [[domainId, otherDomainId]]);
  await db().end();
});

describe("domain-bound inbound delivery", () => {
  it("accepts inbound mail only from accounts authorized for the recipient domain", async () => {
    await expect(setDomainInboundSources(domainId, ["missing-account"], "test")).rejects.toThrow("must exist");
    expect((await query<{provider_account_id:string}>("SELECT provider_account_id FROM domain_inbound_sources WHERE sending_domain_id=$1", [domainId])).rows)
      .toEqual([{provider_account_id:"pa_mock"}]);
    await setDomainInboundSources(domainId, [], "test");
    try {
      const externalId = await deliver([`help@${domain}`]);
      const copies = (await query<{service_id:string|null}>("SELECT service_id FROM inbound_messages WHERE external_message_id=$1", [externalId])).rows;
      expect(copies).toEqual([{service_id:null}]);
    } finally {
      await setDomainInboundSources(domainId, ["pa_mock"], "test");
    }
    const externalId = await deliver([`help@${domain}`]);
    const copies = (await query<{service_id:string|null}>("SELECT service_id FROM inbound_messages WHERE external_message_id=$1 ORDER BY service_id", [externalId])).rows;
    expect(copies).toEqual([{service_id:services[0]},{service_id:services[1]}]);
  });
  it("fans out one domain to every bound Service and isolates a second domain", async () => {
    const externalId = await deliver([`help@${domain}`, `alias@${domain}`, `private@${otherDomain}`]);
    const copies = (await query<{ id: string; service_id: string }>("SELECT id,service_id FROM inbound_messages WHERE external_message_id=$1 ORDER BY service_id", [externalId])).rows;
    expect(copies.map(copy => copy.service_id)).toEqual(services);
    for (const copy of copies) {
      const own = await getInboundMessage(copy.id, copy.service_id);
      expect(own?.status).toBe("ready");
      expect(own?.envelopeRecipients).toEqual(copy.service_id === services[2] ? [`private@${otherDomain}`] : [`alias@${domain}`, `help@${domain}`]);
      expect(await getInboundMessage(copy.id, services.find(id => id !== copy.service_id)!)).toBeNull();
    }
  });

  it("quarantines missing recipients but stores unbound domains for administrators", async () => {
    const missing = await deliver();
    const rejected = (await query<{ service_id: string | null; status: string; rejection_reason: string }>(
      "SELECT service_id,status,rejection_reason FROM inbound_messages WHERE external_message_id=$1", [missing]
    )).rows;
    expect(rejected).toEqual([{ service_id: null, status: "rejected", rejection_reason: "ENVELOPE_RECIPIENT_UNAVAILABLE" }]);

    const unbound = await deliver([`help@unbound-${tag}.test`]);
    const stored = (await query<{ service_id: string | null; status: string; rejection_reason: string | null }>(
      "SELECT service_id,status,rejection_reason FROM inbound_messages WHERE external_message_id=$1", [unbound]
    )).rows;
    expect(stored).toEqual([{ service_id: null, status: "ready", rejection_reason: null }]);
  });

  it("revokes access to existing copies when a receiving binding is disabled", async () => {
    const externalId = await deliver([`help@${domain}`]);
    const own = (await query<{ id: string }>("SELECT id FROM inbound_messages WHERE external_message_id=$1 AND service_id=$2", [externalId, services[0]])).rows[0].id;
    await query("UPDATE service_domain_bindings SET receive_enabled=false WHERE service_id=$1 AND sending_domain_id=$2", [services[0], domainId]);
    try {
      expect(await getInboundMessage(own, services[0])).toBeNull();
      expect((await listInboundMessages(services[0], { limit: 100 })).data).toEqual([]);
      const next = await deliver([`help@${domain}`]);
      expect((await query<{ service_id: string }>("SELECT service_id FROM inbound_messages WHERE external_message_id=$1", [next])).rows.map(row => row.service_id)).toEqual([services[1]]);
    } finally {
      await query("UPDATE service_domain_bindings SET receive_enabled=true WHERE service_id=$1 AND sending_domain_id=$2", [services[0], domainId]);
    }
    expect(await getInboundMessage(own, services[0])).not.toBeNull();
  });

  it("honors explicit receive revocation after a webhook is accepted", async () => {
    const externalMessageId = crypto.randomUUID();
    externalIds.push(externalMessageId);
    const received = await ingestProviderWebhook("mock", "test-endpoint", {
      rawBody: Buffer.from(JSON.stringify({ id: crypto.randomUUID(), type: "inbound.received", externalMessageId,
        envelopeRecipients: [`help@${domain}`], from: "sender@example.net", to: [`help@${domain}`], subject: "Revoked after accept", text: "Body" })),
      headers: { authorization: "Bearer test-webhook-token" }
    });
    if (received.status !== 202) throw new Error("Expected accepted webhook");
    rawIds.push(received.id);
    await query("UPDATE service_domain_bindings SET receive_enabled=false WHERE service_id=$1 AND sending_domain_id=$2", [services[0], domainId]);
    try {
      await processRawProviderEvent(received.id);
      const copies = (await query<{ service_id: string; status: string }>("SELECT service_id,status FROM inbound_messages WHERE external_message_id=$1 ORDER BY service_id", [externalMessageId])).rows;
      expect(copies).toEqual([{ service_id: services[1], status: "ready" }]);
      expect((await query<{ processed_at: Date | null }>("SELECT processed_at FROM raw_provider_events WHERE id=$1", [received.id])).rows[0].processed_at).not.toBeNull();
    } finally {
      await query("UPDATE service_domain_bindings SET receive_enabled=true WHERE service_id=$1 AND sending_domain_id=$2", [services[0], domainId]);
    }
  });

  it("does not partially deliver a multi-domain Service copy after one domain is revoked", async () => {
    const extraBinding = `sdb_multi_${tag}`;
    const externalMessageId = crypto.randomUUID();
    externalIds.push(externalMessageId);
    await query("INSERT INTO service_domain_bindings(id,service_id,sending_domain_id,receive_enabled) VALUES($1,$2,$3,true)",
      [extraBinding, services[0], otherDomainId]);
    try {
      const received = await ingestProviderWebhook("mock", "test-endpoint", {
        rawBody: Buffer.from(JSON.stringify({ id: crypto.randomUUID(), type: "inbound.received", externalMessageId,
          envelopeRecipients: [`help@${domain}`, `private@${otherDomain}`], from: "sender@example.net",
          to: [`help@${domain}`], subject: "Two domains", text: "Body" })),
        headers: { authorization: "Bearer test-webhook-token" }
      });
      if (received.status !== 202) throw new Error("Expected accepted webhook");
      rawIds.push(received.id);
      const frozen = (await query<{ routes: Array<{ service_id: string; recipients: string[] }> }>(
        "SELECT routes FROM inbound_receipts WHERE provider_account_id='pa_mock' AND external_message_id=$1", [externalMessageId])).rows[0];
      expect(frozen.routes.find(route => route.service_id === services[0])?.recipients).toHaveLength(2);
      await query("UPDATE service_domain_bindings SET receive_enabled=false WHERE id=$1", [extraBinding]);
      await processRawProviderEvent(received.id);
      const copies = (await query<{ service_id: string; status: string }>(
        "SELECT service_id,status FROM inbound_messages WHERE external_message_id=$1 ORDER BY service_id", [externalMessageId])).rows;
      expect(copies).toEqual([{ service_id: services[1], status: "ready" }, { service_id: services[2], status: "ready" }]);
    } finally {
      await query("DELETE FROM service_domain_bindings WHERE id=$1", [extraBinding]);
    }
  });

  it("creates independent fanout copies for Postmark recipients sharing MessageID", async () => {
    const adapter = providerRegistry("postmark");
    const context = { accountId: "pa_mock", config: { type: "postmark" as const, schemaVersion: 1 as const, messageStream: "outbound" }, secret: { type: "postmark" as const, serverToken: "test" } };
    for (const recipient of [`support@${domain}`, `billing@${domain}`]) {
      const verified = { valid: true, replaySafe: true, nativeType: "Inbound", providerEventId: crypto.randomUUID(),
        parsed: { RecordType: "Inbound", MessageID: "shared-postmark-message", OriginalRecipient: recipient, From: "sender@example.net", To: recipient, Subject: "Shared provider ID", TextBody: "Body" } };
      const mail = await adapter.inbound!.receive(verified, context);
      if (!mail) throw new Error("Expected Postmark inbound message");
      externalIds.push(mail.externalMessageId);
      await persistInbound({ providerAccountId: "pa_mock", webhookEndpointId: "pwe_mock", rawEventId: null!, message: mail });
    }
    const copies = (await query<{ service_id: string; external_message_id: string }>("SELECT service_id,external_message_id FROM inbound_messages WHERE external_message_id=ANY($1) ORDER BY external_message_id,service_id", [externalIds.slice(-2)])).rows;
    expect(copies).toHaveLength(4);
    expect(new Set(copies.map(copy => copy.external_message_id)).size).toBe(2);
    expect(copies.filter(copy => copy.service_id === services[0])).toHaveLength(2);
    expect(copies.filter(copy => copy.service_id === services[1])).toHaveLength(2);
  });
});
