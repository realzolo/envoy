import { Webhook } from "svix";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestProviderWebhook } from "@/modules/inbound/public";
import { acceptMessage, prepareSubmission, markAccepted, getMessageAttempts, applyCanonicalEvent, processRawProviderEvent, listOutboundChanges } from "@/modules/outbound/public";
import { createMessageSchema, outboundChangePageSchema } from "@/lib/contracts";
import { db, query } from "@/platform/database";
import { sealSecret } from "@/platform/crypto/envelope";

const suffix = crypto.randomUUID().replaceAll("-", ""), accountId = `pa_rfc_${suffix}`, endpointId = `pwe_rfc_${suffix}`;
const token = `rfc-${suffix}`, domainId = `sd_rfc_${suffix}`, domain = `rfc-${suffix}.test`, serviceId = `svc_rfc_${suffix}`, providerIdentityId = `pi_rfc_${suffix}`;
const signingSecret = `whsec_${Buffer.from("actual-rfc-integration-key").toString("base64")}`;
const identity = { serviceId, serviceName: "RFC fixtures", rateLimitPerMinute: 600 };
const callbackId = `cb_rfc_${suffix}`;
const rawIds: string[] = [];

beforeAll(async () => {
  const provider = sealSecret({ type: "resend", apiKey: "re_rfc_fixture" }, accountId, 1), security = sealSecret({ signingSecret }, endpointId, 1);
  await query("INSERT INTO provider_accounts(id,type,name,status,public_config,health,quota) VALUES($1,'resend',$1,'active','{}',$2,$3)", [accountId, { status: "healthy" }, { monthlyLimit: 100000 }]);
  await query("INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by) VALUES($1,$2,1,$3,$4,$5,'test')", [`pc_rfc_${suffix}`, accountId, provider.secretCiphertext, provider.encryptedDek, provider.keyVersion]);
  await query("INSERT INTO provider_webhook_endpoints(id,provider_account_id,opaque_token,security_config_ciphertext,security_encrypted_dek,key_version,security_version,security_configured) VALUES($1,$2,$3,$4,$5,$6,1,true)", [endpointId, accountId, token, security.secretCiphertext, security.encryptedDek, security.keyVersion]);
  await query("INSERT INTO sending_domains(id,domain) VALUES($1,$2)", [domainId, domain]);
  await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,external_identity_id,status) VALUES($1,$2,$3,'fixture_identity','verified')", [providerIdentityId, domainId, accountId]);
  await query("INSERT INTO services(id,name) VALUES($1,'RFC fixtures')", [serviceId]);
  await query("INSERT INTO service_domain_bindings(id,service_id,sending_domain_id,outbound_provider_identity_id) VALUES($1,$2,$3,$4)", [`sdb_rfc_${suffix}`, serviceId, domainId, providerIdentityId]);
  const callback = sealSecret({ secret: "rfc-fixture-callback-secret" }, callbackId, 1);
  await query("INSERT INTO callback_endpoints(id,service_id,name,url,secret_ciphertext,encrypted_dek,key_version,subscribed_events) VALUES($1,$2,'RFC fixture callback','https://callback.example.test/rfc',$3,$4,$5,$6)", [callbackId, serviceId, callback.secretCiphertext, callback.encryptedDek, callback.keyVersion, ["email.accepted", "email.delivered"]]);
});

afterAll(async () => {
  await query("DELETE FROM outbox_events WHERE aggregate_id=ANY($1) OR payload->>'rawEventId'=ANY($1) OR payload->>'submissionId' IN (SELECT s.id FROM submissions s JOIN messages m ON m.id=s.message_id WHERE m.service_id=$2) OR payload->>'callbackDeliveryId' IN (SELECT id FROM callback_deliveries WHERE endpoint_id=$3)", [rawIds, serviceId, callbackId]);
  await query("DELETE FROM callback_endpoints WHERE id=$1", [callbackId]);
  await query("DELETE FROM raw_provider_events WHERE provider_account_id=$1", [accountId]);
  await query("DELETE FROM messages WHERE service_id=$1", [serviceId]);
  await query("DELETE FROM services WHERE id=$1", [serviceId]);
  await query("DELETE FROM provider_identities WHERE id=$1", [providerIdentityId]);
  await query("DELETE FROM sending_domains WHERE id=$1", [domainId]);
  await query("DELETE FROM provider_webhook_endpoints WHERE id=$1", [endpointId]);
  await query("DELETE FROM provider_credentials WHERE provider_account_id=$1", [accountId]);
  await query("DELETE FROM provider_accounts WHERE id=$1", [accountId]);
  await db().end();
});

async function fixture() {
  const accepted = await acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input: createMessageSchema.parse({
    from: { email: `help@${domain}` }, to: [{ email: "recipient@example.net" }], subject: "Actual RFC fixture", text: "Independent body"
  }) });
  const submission = (await query<{ id: string }>("SELECT id FROM submissions WHERE message_id=$1", [accepted.message.id])).rows[0];
  const prepared = await prepareSubmission(submission.id);
  if (!prepared || "reconcileAttemptId" in prepared) throw new Error("Expected fresh attempt");
  const externalId = crypto.randomUUID();
  await markAccepted(prepared.attemptId, externalId);
  return { messageId: accepted.message.id, attemptId: prepared.attemptId, externalId };
}

async function webhook(externalId: string, rfcMessageId: string, recipient = "recipient@example.net", type = "email.delivered") {
  const eventId = `svix-${crypto.randomUUID()}`, timestamp = new Date();
  const rawBody = Buffer.from(JSON.stringify({ type, created_at: timestamp.toISOString(), data: {
    email_id: externalId, message_id: rfcMessageId, to: [recipient], subject: "private echo must be purged"
  } }));
  const result = await ingestProviderWebhook("resend", token, { rawBody, headers: { "svix-id": eventId,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)), "svix-signature": new Webhook(signingSecret).sign(eventId, timestamp, rawBody) } });
  if (result.status !== 202) throw new Error(`Expected accepted webhook: ${result.error}`);
  rawIds.push(result.id);
  return result.id;
}

describe("confirmed outbound identity from signed provider facts", () => {
  it("advances the existing stream once when late email.sent confirms identity after terminal delivery", async () => {
    const row = await fixture(), rfc = "<Late.Actual@provider.example>";
    await applyCanonicalEvent(accountId, null, { id: crypto.randomUUID(), externalMessageId: row.externalId, type: "delivered", recipient: "recipient@example.net", occurredAt: new Date(), metadata: {} });
    const before = await listOutboundChanges(serviceId, 100);
    const current = (await query("SELECT d.id,d.lifecycle_status,d.revision FROM deliveries d WHERE d.message_id=$1", [row.messageId])).rows[0];
    const callbacks = (await query("SELECT id FROM callback_deliveries WHERE endpoint_id=$1", [callbackId])).rowCount;
    expect(callbacks).toBeGreaterThan(0);
    await processRawProviderEvent(await webhook(row.externalId, rfc, "recipient@example.net", "email.sent"));
    const page = await listOutboundChanges(serviceId, 100, before.nextCursor);
    expect(outboundChangePageSchema.safeParse(page).success).toBe(true);
    expect(page.data).toMatchObject([{ messageId: row.messageId, type: "identity_confirmed" }]);
    expect((await query("SELECT d.id,d.lifecycle_status,d.revision FROM deliveries d WHERE d.message_id=$1", [row.messageId])).rows[0]).toEqual(current);
    expect((await query("SELECT id FROM callback_deliveries WHERE endpoint_id=$1", [callbackId])).rowCount).toBe(callbacks);
    const id = page.data[0].id;
    expect((await query("SELECT source_key,event_type FROM submission_events WHERE id=$1", [id])).rows[0]).toEqual({ source_key: `attempt:${row.attemptId}:identity_confirmed`, event_type: "identity_confirmed" });
    await processRawProviderEvent(await webhook(row.externalId, rfc, "recipient@example.net", "email.sent"));
    await processRawProviderEvent(await webhook(row.externalId, "<Different@provider.example>", "recipient@example.net", "email.sent"));
    expect((await listOutboundChanges(serviceId, 100, page.nextCursor)).data).toEqual([]);
    expect((await getMessageAttempts(row.messageId, serviceId, { limit: 10 }))!.data[0].rfcMessageId).toBe(rfc);
  });

  it("captures the exact actual RFC through verified ingest and normalized replay without overwriting it", async () => {
    const row = await fixture(), rfc = "<Actual.Case-Reply@provider.example>";
    expect((await getMessageAttempts(row.messageId, serviceId, { limit: 10 }))!.data[0]).toMatchObject({ rfcMessageId: null, rfcMessageIdStatus: "unknown" });
    const rawId = await webhook(row.externalId, rfc);
    await processRawProviderEvent(rawId);
    expect((await getMessageAttempts(row.messageId, serviceId, { limit: 10 }))!.data[0]).toMatchObject({ rfcMessageId: rfc, rfcMessageIdStatus: "confirmed" });
    const stored = (await query("SELECT normalized_events,verification,raw_body,raw_payload_purged_at FROM raw_provider_events WHERE id=$1", [rawId])).rows[0];
    expect(stored).toMatchObject({ normalized_events: [expect.objectContaining({ rfcMessageId: rfc })], verification: {}, raw_body: null, raw_payload_purged_at: expect.any(Date) });
    expect(JSON.stringify(stored)).not.toContain("private echo");
    // Replaying only the normalized facts must retain the exact actual header.
    await query("UPDATE submission_attempts SET rfc_message_id=NULL WHERE id=$1", [row.attemptId]);
    await query("UPDATE raw_provider_events SET processed_at=NULL,next_attempt_at=now() WHERE id=$1", [rawId]);
    await processRawProviderEvent(rawId);
    expect((await getMessageAttempts(row.messageId, serviceId, { limit: 10 }))!.data[0].rfcMessageId).toBe(rfc);
    await processRawProviderEvent(await webhook(row.externalId, "<Conflicting@provider.example>"));
    await markAccepted(row.attemptId, row.externalId, {}, null);
    expect((await getMessageAttempts(row.messageId, serviceId, { limit: 10 }))!.data[0].rfcMessageId).toBe(rfc);
  });

  it("refuses to confirm from another account, unknown external ID, or unmatched recipient", async () => {
    const row = await fixture();
    const event = { id: crypto.randomUUID(), type: "delivered" as const, externalMessageId: row.externalId, rfcMessageId: "<Other@provider.example>", recipient: "recipient@example.net", occurredAt: new Date(), metadata: {} };
    expect(await applyCanonicalEvent("pa_mock", null, event)).toBe(false);
    expect(await applyCanonicalEvent(accountId, null, { ...event, externalMessageId: "unknown" })).toBe(false);
    expect(await applyCanonicalEvent(accountId, null, { ...event, recipient: "other@example.net" })).toBe(false);
    expect((await getMessageAttempts(row.messageId, serviceId, { limit: 10 }))!.data[0].rfcMessageId).toBeNull();
  });
});
