import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, query } from "@/platform/database";
import { persistInbound, getInboundMessage, listInboundMessages } from "@/modules/inbound/public";

const tag = crypto.randomUUID().replaceAll("-", "");
const domain = `access-${tag}.test`;
const otherDomain = `other-${tag}.test`;
const domainId = `sd_${tag}`;
const otherDomainId = `sd_other_${tag}`;
const services = [`svc_a_${tag}`, `svc_b_${tag}`, `svc_c_${tag}`];
const externalIds: string[] = [];

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
  await query("INSERT INTO sending_domains(id,domain,inbound_provider_account_id) VALUES($1,$2,'pa_mock'),($3,$4,'pa_mock')", [domainId, domain, otherDomainId, otherDomain]);
  for (const [index, serviceId] of services.entries()) {
    await query("INSERT INTO service_domain_bindings(id,service_id,sending_domain_id,receive_enabled) VALUES($1,$2,$3,true)", [`sdb_${index}_${tag}`, serviceId, index === 2 ? otherDomainId : domainId]);
  }
});

afterAll(async () => {
  await query("DELETE FROM inbound_messages WHERE external_message_id=ANY($1)", [externalIds]);
  await query("DELETE FROM inbound_receipts WHERE external_message_id=ANY($1)", [externalIds]);
  await query("DELETE FROM services WHERE id=ANY($1)", [services]);
  await query("DELETE FROM sending_domains WHERE id=ANY($1)", [[domainId, otherDomainId]]);
  await db().end();
});

describe("domain-bound inbound delivery", () => {
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

  it("requires the configured provider endpoint and a trusted envelope recipient", async () => {
    for (const [recipients, endpoint, reason] of [[undefined, "pwe_mock", "ENVELOPE_RECIPIENT_UNAVAILABLE"], [[`help@${domain}`], "missing-endpoint", "NO_RECEIVING_SERVICE"]] as const) {
      const externalId = await deliver(recipients ? [...recipients] : undefined, endpoint);
      const copy = (await query<{ service_id: string | null; status: string; rejection_reason: string }>("SELECT service_id,status,rejection_reason FROM inbound_messages WHERE external_message_id=$1", [externalId])).rows;
      expect(copy).toEqual([{ service_id: null, status: "rejected", rejection_reason: reason }]);
    }
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
});
