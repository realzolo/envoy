vi.mock("@/server/admin-auth", () => ({ getAdminSession: vi.fn().mockResolvedValue({ email: "admin@example.test" }) }));
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { MessageContent } from "@/modules/outbound/contracts";
import { createMessageSchema } from "@/lib/contracts";
import { acceptMessage, getMessage, retryMessage, IdempotencyConflictError } from "@/modules/outbound/public";
import { purgeExpiredSensitiveContent, sendingContent } from "@/modules/outbound/public";
import { getDeliveryDetail } from "@/server/admin-queries";
import { applyCanonicalEvent, processRawProviderEvent } from "@/modules/outbound/public";
import { prepareSubmission, markAccepted, markUnknown, markDeterminateFailure, markReconciled } from "@/modules/outbound/public";
import { providerRegistry } from "@/integrations/providers/registry";
import { ingestProviderWebhook } from "@/modules/inbound/public";
import { GET as messageApi } from "@/app/api/v1/messages/[id]/route";
import { GET as capabilitiesApi } from "@/app/api/v1/capabilities/route";
import { objectStore } from "@/platform/storage/object-store";
import { uploadOutboundFile } from "@/modules/attachments/public";
import { scanClean } from "../helpers/scanner";
import { purgeContent } from "@/modules/identity/public";
import { processDelivery } from "@/worker/delivery";
import { db, query } from "@/platform/database";

const identity = { serviceId: "svc_atlas_auth", serviceName: "Atlas Auth", rateLimitPerMinute: 600 };
const secret = "PRIVATE-CONTENT-728941";
const ids: string[] = [];
const raws: string[] = [];
const input = () => createMessageSchema.parse({ category: "security", from: { email: "verification@mail.atlas.test", name: secret },
  to: [{ email: `private-${crypto.randomUUID()}@example.net`, name: secret }], subject: secret, html: `<p>${secret}</p>`, text: secret,
  replyTo: [{ email: "reply@example.net", name: secret }], headers: { "X-Context": secret }, metadata: { context: secret }, tags: { context: secret },
  inReplyTo: `<${secret}@example.net>`, references: [`<${secret}@example.net>`], referenceId: crypto.randomUUID(),
  contentPolicy: "sensitive", sendBefore: new Date(Date.now() + 240_000).toISOString() });
async function fixture(value = input(), key = crypto.randomUUID()) {
  const accepted = await acceptMessage({ identity, input: value, idempotencyKey: key });
  ids.push(accepted.message.id);
  const submission = (await query<{ id: string }>("SELECT id FROM submissions WHERE message_id=$1", [accepted.message.id])).rows[0];
  return { id: accepted.message.id, submissionId: submission.id, value, key, receipt: accepted.message };
}
async function prepare(submissionId: string) {
  const attempt = await prepareSubmission(submissionId);
  if (!attempt || "reconcileAttemptId" in attempt) throw new Error("Expected prepared submission");
  return attempt;
}
async function expire(id: string) { await query("UPDATE messages SET send_before=clock_timestamp()-interval '1 second' WHERE id=$1", [id]); }
const request = () => new Request("http://localhost/api/v1/messages", { headers: { authorization: "Bearer envoy_test_key" } });

afterAll(async () => {
  vi.restoreAllMocks();
  await query("DELETE FROM outbox_events WHERE payload->>'submissionId' IN(SELECT id FROM submissions WHERE message_id=ANY($1::text[])) OR payload->>'attemptId' IN(SELECT a.id FROM submission_attempts a JOIN submissions s ON s.id=a.submission_id WHERE s.message_id=ANY($1::text[])) OR payload->>'callbackDeliveryId' IN(SELECT id FROM callback_deliveries WHERE payload#>>'{data,messageId}'=ANY($1::text[]))", [ids]);
  await query("DELETE FROM messages WHERE id=ANY($1::text[])", [ids]);
  await query("DELETE FROM inbound_messages WHERE raw_provider_event_id=ANY($1::text[])", [raws]);
  await query("DELETE FROM raw_provider_events WHERE id=ANY($1::text[])", [raws]);
  const files = (await query<{ id: string; object_key: string }>("SELECT id,object_key FROM outbound_files WHERE file_name='deadline-fixture.png'")).rows;
  for (const file of files) { await objectStore().delete(file.object_key); await query("DELETE FROM outbound_files WHERE id=$1", [file.id]); }
  await db().end();
});

describe("sensitive content and sending deadline", () => {
  it("requires a bounded sensitive retention period and advertises the exact capability", async () => {
    for (const sendBefore of [undefined, new Date(Date.now() + 901_000).toISOString()]) await expect(acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input: { ...input(), sendBefore } })).rejects.toMatchObject({ code: "INVALID_SENSITIVE_RETENTION" });
    await expect(acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input: { ...input(), sendBefore: new Date(Date.now() - 1000).toISOString() } })).rejects.toMatchObject({ code: "SEND_DEADLINE_EXCEEDED" });
    const capabilities = await (await capabilitiesApi(request())).json();
    expect(capabilities.messagePolicies).toEqual({ sendBefore: true, contentPolicies: ["normal", "sensitive"], sensitive: { requiresSendBefore: true, maxRetentionSeconds: 900, contentReadable: false } });
  });

  it("encrypts every free-form request field, decrypts only for send, and never exposes content in API/admin", async () => {
    const row = await fixture();
    const stored = (await query<MessageContent>("SELECT * FROM messages WHERE id=$1", [row.id])).rows[0];
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored).toMatchObject({ content_policy: "sensitive", subject: "[Sensitive content]", html_body: null, text_body: null });
    expect(stored.sensitive_content!.secretCiphertext).toBeTypeOf("string");
    expect(sendingContent(stored)).toMatchObject({ subject: secret, html_body: `<p>${secret}</p>`, metadata: { context: secret } });
    const prepared = await prepare(row.submissionId);
    expect(prepared.message).toMatchObject({ subject: secret, text: secret, from: { name: secret } });
    await markAccepted(prepared.attemptId, crypto.randomUUID(), { submitted_body: secret });
    const delivery = (await getMessage(row.id, identity.serviceId))!.deliveries[0];
    const detail = await (await messageApi(request(), { params: Promise.resolve({ id: row.id }) })).json();
    expect(detail).toMatchObject({ outcome: "pending", html: null, text: null, subject: "[Sensitive content]", metadata: {}, tags: {}, headers: {}, attachments: [], contentPolicy: "sensitive", deliveries: [{ lifecycle: "accepted", acceptedAt: expect.any(String), deliveredAt: null }] });
    expect(JSON.stringify(detail)).not.toContain(secret);
    expect(JSON.stringify(await getDeliveryDetail(delivery.id))).not.toContain(secret);
    const copies = await query("SELECT to_jsonb(a) AS data FROM submission_attempts a WHERE submission_id=$1 UNION ALL SELECT canonical_payload FROM submission_events WHERE submission_id=$1", [row.submissionId]);
    expect(JSON.stringify(copies.rows)).not.toContain(secret);
  });

  it("keeps idempotent receipts after deadline, body purge, and KEK rotation without accepting different content", async () => {
    const row = await fixture();
    await expire(row.id);
    await purgeExpiredSensitiveContent();
    expect((await query("SELECT sensitive_content,sensitive_content_purged_at FROM messages WHERE id=$1", [row.id])).rows[0]).toMatchObject({ sensitive_content: null, sensitive_content_purged_at: expect.any(Date) });
    const previousVersion = process.env.ENVOY_KEK_VERSION;
    const previousRing = process.env.ENVOY_KEK_KEYRING_JSON;
    process.env.ENVOY_KEK_VERSION = "test-new";
    process.env.ENVOY_KEK_KEYRING_JSON = JSON.stringify({ "local-1": process.env.ENVOY_KEK_BASE64 });
    try {
      expect(await acceptMessage({ identity, idempotencyKey: row.key, input: row.value })).toEqual({ duplicate: true, message: row.receipt });
      await expect(acceptMessage({ identity, idempotencyKey: row.key, input: { ...row.value, text: "different" } })).rejects.toThrow(IdempotencyConflictError);
    } finally {
      if (previousVersion === undefined) delete process.env.ENVOY_KEK_VERSION; else process.env.ENVOY_KEK_VERSION = previousVersion;
      if (previousRing === undefined) delete process.env.ENVOY_KEK_KEYRING_JSON; else process.env.ENVOY_KEK_KEYRING_JSON = previousRing;
    }
    expect(await prepareSubmission(row.submissionId)).toBeNull();
    expect((await getMessage(row.id, identity.serviceId))?.deliveries[0]).toMatchObject({ lifecycle_status: "failed", last_error: { code: "SEND_DEADLINE_EXCEEDED", acceptance: "not_accepted" } });
  });

  it("prevents expired queued work, manual retry, and determinate-rejection failover", async () => {
    const row = await fixture();
    const prepared = await prepare(row.submissionId);
    await expire(row.id);
    await markDeterminateFailure(prepared.attemptId, { category: "provider", code: "PROVIDER_REJECTED", message: secret }, true);
    expect((await query("SELECT status,diagnostic FROM submission_attempts WHERE id=$1", [prepared.attemptId])).rows[0]).toMatchObject({ status: "failed", diagnostic: { code: "SEND_DEADLINE_EXCEEDED", retryable: false, retryDecision: { action: "none" } } });
    expect(await prepareSubmission(row.submissionId)).toBeNull();
    const retry = await retryMessage(row.id, identity.serviceId, { acknowledgeDuplicateRisk: true }, crypto.randomUUID());
    expect(retry).toMatchObject({ queued: 0, skipped: [{ reason: "send_deadline_exceeded" }] });
  });

  it("checks the deadline again after waiting on attachment storage and sends zero provider requests", async () => {
    const file = await uploadOutboundFile(identity.serviceId, "deadline-fixture.png", "image/png", Buffer.from([1,2,3,4]), "mail.atlas.test");
    await scanClean(file.id);
    const value = { ...input(), attachments: [{ fileId: file.id, disposition: "inline" as const, contentId: "logo", fileName: secret }], sendBefore: new Date(Date.now() + 250).toISOString() };
    const row = await fixture(value);
    const store = objectStore(); const original = store.get.bind(store);
    const get = vi.spyOn(store, "get").mockImplementationOnce(async (...args) => {
      const bytes = await original(...args);
      await new Promise(resolve => setTimeout(resolve, Math.max(1, Date.parse(value.sendBefore) - Date.now() + 20)));
      return bytes;
    });
    const send = vi.spyOn(providerRegistry("mock").sender, "send");
    try {
      await processDelivery({ data: { submissionId: row.submissionId } } as Job<{ submissionId: string }>);
      expect(get).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
      expect((await getMessage(row.id, identity.serviceId))?.deliveries[0]).toMatchObject({ lifecycle_status: "failed", last_error: { code: "SEND_DEADLINE_EXCEEDED" } });
    } finally { get.mockRestore(); send.mockRestore(); }
  });

  it("does not rewrite an unknown or accepted attempt when its deadline passes", async () => {
    const row = await fixture();
    const prepared = await prepare(row.submissionId);
    await markUnknown(prepared.attemptId, secret, { providerCode: secret });
    await expire(row.id);
    await purgeExpiredSensitiveContent();
    expect(await prepareSubmission(row.submissionId)).toEqual({ reconcileAttemptId: prepared.attemptId });
    await markReconciled(prepared.attemptId, "unknown");
    expect((await getMessage(row.id, identity.serviceId))?.outcome).toBe("unknown");
    await markAccepted(prepared.attemptId, crypto.randomUUID(), { subject: secret });
    expect((await getMessage(row.id, identity.serviceId))?.deliveries[0].lifecycle_status).toBe("accepted");
    expect(await prepareSubmission(row.submissionId)).toBeNull();
  });

  it("stops reconciliation-confirmed rejection after the deadline", async () => {
    const row = await fixture(); const prepared = await prepare(row.submissionId);
    await markUnknown(prepared.attemptId, secret); await expire(row.id);
    await markReconciled(prepared.attemptId, "not_accepted");
    expect((await getMessage(row.id, identity.serviceId))?.deliveries[0]).toMatchObject({ lifecycle_status: "failed", last_error: { code: "SEND_DEADLINE_EXCEEDED" } });
    expect(await prepareSubmission(row.submissionId)).toBeNull();
  });

  it("stores only normalized provider facts, encrypts raw receipts, and clears outbound raw copies", async () => {
    const row = await fixture(); const prepared = await prepare(row.submissionId); const externalId = crypto.randomUUID();
    await markAccepted(prepared.attemptId, externalId);
    await applyCanonicalEvent("pa_mock", null, { id: crypto.randomUUID(), externalMessageId: externalId, type: "bounced", recipient: row.value.to[0].email, occurredAt: new Date(), bounce: { classification: "soft", code: secret, message: secret }, metadata: { reason: secret, url: secret, providerCode: secret } });
    const stored = (await query("SELECT canonical_payload FROM delivery_events WHERE delivery_id IN(SELECT id FROM deliveries WHERE message_id=$1)", [row.id])).rows;
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify((await query("SELECT payload FROM callback_deliveries WHERE payload#>>'{data,messageId}'=$1", [row.id])).rows)).not.toContain(secret);
    const raw = await ingestProviderWebhook("mock", "test-endpoint", { rawBody: Buffer.from(JSON.stringify({ id: crypto.randomUUID(), type: "delivered", externalMessageId: externalId, recipient: row.value.to[0].email, body: secret })), headers: { authorization: "Bearer test-webhook-token", "x-untrusted-content": secret } });
    if (raw.status !== 202) throw new Error("Expected raw receipt"); raws.push(raw.id);
    const before = (await query("SELECT raw_body,headers,verification FROM raw_provider_events WHERE id=$1", [raw.id])).rows[0];
    expect(Buffer.from(before.raw_body).toString()).not.toContain(secret);
    expect(JSON.stringify(before)).not.toContain(secret);
    await processRawProviderEvent(raw.id);
    expect((await query("SELECT raw_body,verification,raw_payload_purged_at FROM raw_provider_events WHERE id=$1", [raw.id])).rows[0]).toMatchObject({ raw_body: null, verification: {}, raw_payload_purged_at: expect.any(Date) });
    expect((await getMessage(row.id, identity.serviceId))?.outcome).toBe("succeeded");
  });

  it("preserves unprocessed inbound receipts across long worker downtime and does not guess unknown events are outbound", async () => {
    for (const type of ["inbound.received", "unsupported.provider.event"]) {
      const raw = await ingestProviderWebhook("mock", "test-endpoint", { rawBody: Buffer.from(JSON.stringify({ id: crypto.randomUUID(), type, externalMessageId: crypto.randomUUID(), from: "sender@example.net", to: ["support@mail.atlas.test"], envelopeRecipients: ["support@mail.atlas.test"], subject: "Delayed inbound", text: "Retained inbound content" })), headers: { authorization: "Bearer test-webhook-token" } });
      if (raw.status !== 202) throw new Error("Expected raw receipt"); raws.push(raw.id);
      await query("UPDATE raw_provider_events SET received_at=clock_timestamp()-interval '2 days' WHERE id=$1", [raw.id]);
      await purgeExpiredSensitiveContent();
      const stored = (await query("SELECT raw_body,verification,payload_expires_at,normalized_events,terminated_at,raw_payload_purged_at FROM raw_provider_events WHERE id=$1", [raw.id])).rows[0];
      expect(stored).toMatchObject({ payload_expires_at: null, normalized_events: null, terminated_at: null, raw_payload_purged_at: null });
      expect(stored.raw_body).not.toBeNull(); expect(stored.verification.secretCiphertext).toBeTypeOf("string");
      if (type === "inbound.received") {
        await processRawProviderEvent(raw.id);
        expect((await query("SELECT id FROM inbound_messages WHERE raw_provider_event_id=$1 AND status='ready'", [raw.id])).rowCount).toBe(1);
      }
    }
  });

  it("retains unassociated normalized facts after raw expiry and applies them when a late acceptance associates the message", async () => {
    const row = await fixture(); const attempt = await prepare(row.submissionId); const externalId = crypto.randomUUID();
    const raw = await ingestProviderWebhook("mock", "test-endpoint", { rawBody: Buffer.from(JSON.stringify({ id: crypto.randomUUID(), type: "delivered", externalMessageId: externalId, recipient: row.value.to[0].email, body: secret })), headers: { authorization: "Bearer test-webhook-token" } });
    if (raw.status !== 202) throw new Error("Expected raw receipt"); raws.push(raw.id);
    await query("UPDATE raw_provider_events SET payload_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [raw.id]);
    await purgeExpiredSensitiveContent();
    const stored = (await query("SELECT raw_body,verification,raw_payload_purged_at,terminated_at,processed_at,normalized_events FROM raw_provider_events WHERE id=$1", [raw.id])).rows[0];
    expect(stored).toMatchObject({ raw_body: null, verification: {}, raw_payload_purged_at: expect.any(Date), terminated_at: null, processed_at: null });
    expect(JSON.stringify(stored.normalized_events)).not.toContain(secret);
    await processRawProviderEvent(raw.id);
    expect((await query("SELECT processed_at FROM raw_provider_events WHERE id=$1", [raw.id])).rows[0].processed_at).toBeNull();
    await markAccepted(attempt.attemptId, externalId);
    await query("UPDATE raw_provider_events SET next_attempt_at=now() WHERE id=$1", [raw.id]);
    await processRawProviderEvent(raw.id);
    expect((await getMessage(row.id, identity.serviceId))?.outcome).toBe("succeeded");
  });


  it("purges sensitive encrypted bodies without blocking callback delivery and explicit content deletion", async () => {
    const row = await fixture();
    await processDelivery({ data: { submissionId: row.submissionId } } as Job<{ submissionId: string }>);
    await expire(row.id); await purgeExpiredSensitiveContent();
    expect((await query("SELECT id FROM callback_deliveries WHERE payload#>>'{data,messageId}'=$1 AND payload_purged_at IS NULL", [row.id])).rowCount).toBeGreaterThan(0);
    expect(await purgeContent("message", row.id, identity.serviceId)).toMatchObject({ id: row.id });
    expect((await query("SELECT sensitive_content FROM messages WHERE id=$1", [row.id])).rows[0].sensitive_content).toBeNull();
  });
});
