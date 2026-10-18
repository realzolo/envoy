import { scanClean } from "../helpers/scanner";
import type { Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as submitMail } from "@/app/api/v1/messages/route";
import { POST as uploadFile } from "@/app/api/v1/files/route";
import { GET as inspectRequest } from "@/app/api/v1/requests/[requestId]/route";
import { createMessageSchema } from "@/lib/contracts";
import { acceptMessage, cancelMessage, getMessage, MessageValidationError, retryMessage } from "@/modules/core/message/service";
import { createSuppression, getDelivery, listEvents } from "@/modules/core/resources/service";
import { applyCanonicalEvent } from "@/modules/core/event/service";
import { prepareSubmission, markUnknown, markAccepted, markDeterminateFailure } from "@/modules/core/routing/engine";
import { CanonicalProviderError } from "@/modules/providers/contracts";
import { providerRegistry } from "@/modules/providers/registry";
import { objectStore } from "@/modules/config/object-store";
import { sealSecret } from "@/modules/config/envelope";
import { processDelivery } from "@/worker/delivery";
import { db, query } from "@/server/database";
import { hashApiKey } from "@/server/crypto";

const suffix = crypto.randomUUID().replaceAll("-", "");
const serviceId = `svc_native_${suffix}`;
const grantId = `sg_native_${suffix}`;
const apiKey = `envoy_native_${suffix}`;
const identity = { serviceId, serviceName: "Native integration", productId: "prd_atlas", product: "Atlas", rateLimitPerMinute: 600 };
const base = createMessageSchema.parse({
  category: "security", from: { email: `dynamic-${suffix}@mail.atlas.test`, name: "业务系统动态名称" },
  to: [{ email: `to-${suffix}@example.net`, name: "To Recipient" }],
  cc: [{ email: `cc-${suffix}@example.net` }], bcc: [{ email: `bcc-${suffix}@example.net` }],
  replyTo: [{ email: "reply@example.net", name: "Support" }],
  subject: "Native integration", text: "Native content", html: '<p>Native<img src="cid:logo"/></p>',
  headers: { "X-Business-ID": suffix }, inReplyTo: "<original@example.net>", references: ["<original@example.net>"],
  referenceId: `business-${suffix}`, metadata: { businessId: suffix }
});
const request = (path: string, options: { method?: string; body?: unknown; key?: string; credential?: string } = {}) => new Request(`http://localhost${path}`, {
  method: options.method ?? "GET",
  headers: { authorization: `Bearer ${options.credential ?? apiKey}`, "content-type": "application/json", ...(options.key ? { "idempotency-key": options.key } : {}) },
  ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
});
async function fixture(input = base) {
  const accepted = await acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input });
  const submission = (await query<{ id: string }>("SELECT id FROM submissions WHERE message_id=$1", [accepted.message.id])).rows[0];
  const deliveries = (await query<{ id: string; recipient_email: string; recipient_role: "to" | "cc" | "bcc" }>("SELECT id,recipient_email,recipient_role FROM deliveries WHERE message_id=$1 ORDER BY recipient_role", [accepted.message.id])).rows;
  return { id: accepted.message.id, submissionId: submission.id, deliveries };
}
const job = (submissionId: string) => ({ data: { submissionId } }) as Job<{ submissionId: string }>;

beforeAll(async () => {
  await query("INSERT INTO services(id,product_id,name) VALUES ($1,'prd_atlas','Native integration')", [serviceId]);
  await query("INSERT INTO service_credentials(id,service_id,key_prefix,key_hash) VALUES ($1,$2,'envoy_native',$3)", [`cred_${suffix}`, serviceId, hashApiKey(apiKey)]);
  await query("INSERT INTO service_domain_grants(id,service_id,sending_domain_id,send_allowed,receive_allowed) VALUES ($1,$2,'sd_atlas',true,true)", [grantId, serviceId]);
  const secret = sealSecret({ secret: "native-callback-secret" }, `cb_${suffix}`, 1);
  await query("INSERT INTO callback_endpoints(id,service_id,name,url,secret_ciphertext,encrypted_dek,key_version,subscribed_events) VALUES ($1,$2,'Native callback','https://callback.test/native',$3,$4,$5,$6)", [`cb_${suffix}`, serviceId, secret.secretCiphertext, secret.encryptedDek, secret.keyVersion, ["email.accepted", "email.failed", "email.deferred", "email.delivered", "email.clicked"]]);
});
afterAll(async () => {
  vi.restoreAllMocks();
  const files = (await query<{ object_key: string }>("SELECT object_key FROM outbound_files WHERE service_id=$1", [serviceId])).rows;
  for (const file of files) await objectStore().delete(file.object_key);
  await query("DELETE FROM outbox_events WHERE payload->>'submissionId' IN (SELECT s.id FROM submissions s JOIN messages m ON m.id=s.message_id WHERE m.service_id=$1) OR payload->>'callbackDeliveryId' IN (SELECT c.id FROM callback_deliveries c JOIN callback_endpoints e ON e.id=c.endpoint_id WHERE e.service_id=$1)", [serviceId]);
  await query("DELETE FROM callback_endpoints WHERE service_id=$1", [serviceId]);
  await query("DELETE FROM messages WHERE service_id=$1", [serviceId]);
  await query("DELETE FROM outbound_files WHERE service_id=$1", [serviceId]);
  await query("DELETE FROM services WHERE id=$1", [serviceId]);
  await db().end();
});

describe("native API integration", () => {
  it("uploads a service-owned file and submits one grouped native email with caller-supplied From", async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const uploaded = await uploadFile(new Request("http://localhost/api/v1/files", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "image/png", "x-sending-domain":"mail.atlas.test", "x-file-name": encodeURIComponent("业务标识.png") }, body: bytes }));
    expect(uploaded.status).toBe(201);
    const file = await uploaded.json();
    expect(file).toMatchObject({ fileName: "业务标识.png", size: 4, contentAvailable: true });
    expect(file).not.toHaveProperty("objectKey");
    await scanClean(file.id);
    const response = await submitMail(request("/api/v1/messages", { method: "POST", key: crypto.randomUUID(), body: { ...base, attachments: [{ fileId: file.id, disposition: "inline", contentId: "logo" }] } }));
    expect(response.status).toBe(202);
    const accepted = await response.json();
    const requestId = response.headers.get("x-request-id")!;
    const detail = await getMessage(accepted.id, serviceId);
    expect(detail).toMatchObject({ request_id: requestId, sender_snapshot: { fromEmail: base.from.email, fromName: base.from.name }, to_recipients: base.to, cc_recipients: base.cc, bcc_recipients: base.bcc, reply_to: base.replyTo, headers: base.headers, references_ids: base.references });
    expect(detail!.deliveries.map(item => item.recipient_role).sort()).toEqual(["bcc", "cc", "to"]);
    const submissions = (await query<{ id: string }>("SELECT id FROM submissions WHERE message_id=$1", [accepted.id])).rows;
    expect(submissions).toHaveLength(1);
    const send = vi.spyOn(providerRegistry("mock").sender, "send");
    try {
      await Promise.all([processDelivery(job(submissions[0].id)), processDelivery(job(submissions[0].id))]);
      expect(send).toHaveBeenCalledTimes(1);
      const canonical = send.mock.calls[0][0];
      expect(canonical).toMatchObject({ from: base.from, to: base.to, cc: base.cc, bcc: base.bcc, replyTo: base.replyTo, headers: base.headers, inReplyTo: base.inReplyTo, references: base.references });
      expect(canonical.envelopeRecipients).toBeUndefined();
      expect(canonical.attachments).toHaveLength(1);
      expect(Buffer.from(canonical.attachments[0].content)).toEqual(bytes);
      expect(canonical.attachments[0]).toMatchObject({ fileName: "业务标识.png", contentType: "image/png", disposition: "inline", contentId: "logo" });
      expect((await getMessage(accepted.id, serviceId))?.outcome).toBe("succeeded");
    } finally { send.mockRestore(); }
    const tracking = await inspectRequest(request(`/api/v1/requests/${requestId}`), { params: Promise.resolve({ requestId }) });
    expect(tracking.status).toBe(200);
    expect(await tracking.json()).toMatchObject({ requestId, messageId: accepted.id, statusCode: 202 });
    const foreign = await inspectRequest(request(`/api/v1/requests/${requestId}`, { credential: "envoy_test_key" }), { params: Promise.resolve({ requestId }) });
    expect(foreign.status).toBe(404);
  });

  it("preserves message-scoped engagement without inventing facts for every recipient", async () => {
    const fixtureRow = await fixture();
    const prepared = await prepareSubmission(fixtureRow.submissionId);
    if (!prepared || "reconcileAttemptId" in prepared) throw new Error("Expected submission");
    const externalMessageId = crypto.randomUUID();
    await markAccepted(prepared.attemptId, externalMessageId);
    const fact = { id: crypto.randomUUID(), externalMessageId, type: "clicked" as const, occurredAt: new Date(), metadata: {} };
    await Promise.all([applyCanonicalEvent("pa_mock", null, fact), applyCanonicalEvent("pa_mock", null, fact)]);
    expect((await getMessage(fixtureRow.id, serviceId))!.deliveries.every(item => item.engagement_status === "unopened")).toBe(true);
    const events = await listEvents(serviceId, { limit: 100, messageId: fixtureRow.id });
    const scoped = events.data.filter(item => item.type === "clicked");
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({ scope: "submission", submissionId: fixtureRow.submissionId, deliveryId: null });
    const bcc = fixtureRow.deliveries.find(item => item.recipient_role === "bcc")!;
    await applyCanonicalEvent("pa_mock", null, { ...fact, id: crypto.randomUUID(), recipient: bcc.recipient_email });
    const detail = await getMessage(fixtureRow.id, serviceId);
    expect(detail!.deliveries.filter(item => item.engagement_status === "clicked").map(item => item.id)).toEqual([bcc.id]);
    await applyCanonicalEvent("pa_mock", null, { ...fact, id: crypto.randomUUID(), type: "delivered" });
    const afterUnscopedDelivery = await getMessage(fixtureRow.id, serviceId);
    expect(afterUnscopedDelivery!.deliveries.every(item => item.lifecycle_status === "accepted")).toBe(true);
    expect(afterUnscopedDelivery?.outcome).toBe("pending");
  });

  it("resolves submission uncertainty from trusted scoped events while preserving recipient attribution", async () => {
    const row = await fixture();
    const prepared = await prepareSubmission(row.submissionId);
    if (!prepared || "reconcileAttemptId" in prepared) throw new Error("Expected submission");
    await markUnknown(prepared.attemptId, "The sender lost its submission response");
    const externalMessageId = crypto.randomUUID();
    // A provider reconciliation/receipt can associate an ID before a delayed
    // canonical event resolves acceptance. The fact must stop further polling.
    await query("UPDATE submission_attempts SET external_message_id=$2 WHERE id=$1", [prepared.attemptId, externalMessageId]);
    const fact = { id: crypto.randomUUID(), externalMessageId, type: "clicked" as const, occurredAt: new Date(), metadata: {} };
    await Promise.all([applyCanonicalEvent("pa_mock", null, fact), applyCanonicalEvent("pa_mock", null, fact)]);
    expect((await query("SELECT status,outcome_determinate,diagnostic,reconcile_after,error_message FROM submission_attempts WHERE id=$1", [prepared.attemptId])).rows[0]).toEqual({ status: "accepted", outcome_determinate: true, diagnostic: null, reconcile_after: null, error_message: null });
    expect((await query("SELECT status FROM submissions WHERE id=$1", [row.submissionId])).rows[0].status).toBe("accepted");
    const mail = await getMessage(row.id, serviceId);
    expect(mail!.deliveries.every(item => item.lifecycle_status === "accepted" && item.engagement_status === "unopened")).toBe(true);
    const history = (await listEvents(serviceId, { limit: 100, messageId: row.id })).data;
    expect(history.filter(item => item.type === "clicked")).toHaveLength(1);
    expect(history.some(item => item.type === "unknown" && item.data.diagnostic?.code === "SUBMISSION_OUTCOME_UNKNOWN")).toBe(true);
    for (const acknowledgeDuplicateRisk of [false, true]) {
      const retried = await retryMessage(row.id, serviceId, { acknowledgeDuplicateRisk }, crypto.randomUUID());
      expect(retried?.queued).toBe(0);
      expect(retried?.skipped.every(item => item.reason === "status_not_retryable")).toBe(true);
    }
  });

  it("keeps late event facts distinct from the lifecycle of a newer submission in callbacks", async () => {
    const row = await fixture();
    const prepared = await prepareSubmission(row.submissionId);
    if (!prepared || "reconcileAttemptId" in prepared) throw new Error("Expected submission");
    await markUnknown(prepared.attemptId, "Original response lost");
    const retry = await retryMessage(row.id, serviceId, { acknowledgeDuplicateRisk: true }, crypto.randomUUID());
    const replacement = await prepareSubmission(retry!.submissionId!);
    if (!replacement || "reconcileAttemptId" in replacement) throw new Error("Expected replacement");
    const externalMessageId = crypto.randomUUID();
    await markAccepted(prepared.attemptId, externalMessageId);
    const recipient = row.deliveries[0];
    await applyCanonicalEvent("pa_mock", null, { id: crypto.randomUUID(), externalMessageId, recipient: recipient.recipient_email, type: "delivered", occurredAt: new Date(), metadata: {} });
    const delivery = await getDelivery(recipient.id, serviceId);
    expect(delivery?.lifecycle).toBe("submitting");
    const callbacks = (await query<{ payload: { data: { lifecycle: string; currentLifecycle: string } } }>("SELECT c.payload FROM callback_deliveries c JOIN delivery_events e ON e.id=c.delivery_event_id WHERE e.delivery_id=$1 AND e.event_type='delivered'", [recipient.id])).rows;
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0].payload.data).toMatchObject({ lifecycle: "delivered", currentLifecycle: "submitting" });
  });

  it("retries only the failed Bcc recipient, preserving original visible headers and idempotent retry results", async () => {
    const row = await fixture();
    const prepared = await prepareSubmission(row.submissionId);
    if (!prepared || "reconcileAttemptId" in prepared) throw new Error("Expected submission");
    const externalMessageId = crypto.randomUUID();
    await markAccepted(prepared.attemptId, externalMessageId);
    for (const recipient of row.deliveries) await applyCanonicalEvent("pa_mock", null, { id: crypto.randomUUID(), externalMessageId, type: recipient.recipient_role === "bcc" ? "failed" : "delivered", recipient: recipient.recipient_email, occurredAt: new Date(Date.now() + 1), metadata: { reason: "Temporary recipient failure" } });
    expect((await getMessage(row.id, serviceId))?.outcome).toBe("partially_failed");
    const bcc = row.deliveries.find(item => item.recipient_role === "bcc")!;
    const key = crypto.randomUUID();
    const input = { deliveryIds: [bcc.id], acknowledgeDuplicateRisk: false };
    const results = await Promise.all(Array.from({ length: 8 }, () => retryMessage(row.id, serviceId, input, key)));
    expect(new Set(results.map(item => item?.submissionId)).size).toBe(1);
    expect(results[0]?.queued).toBe(1);
    const retryId = results[0]!.submissionId!;
    const send = vi.spyOn(providerRegistry("mock").sender, "send");
    try {
      await processDelivery(job(retryId));
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0]).toMatchObject({ to: base.to, cc: base.cc, bcc: base.bcc, envelopeRecipients: base.bcc });
      expect((await query<{ delivery_id: string }>("SELECT delivery_id FROM submission_deliveries WHERE submission_id=$1", [retryId])).rows).toEqual([{ delivery_id: bcc.id }]);
      expect((await getMessage(row.id, serviceId))?.outcome).toBe("succeeded");
    } finally { send.mockRestore(); }
  });

  it("rejects a subset retry when the only configured adapter cannot preserve its original headers", async () => {
    const row = await fixture();
    const prepared = await prepareSubmission(row.submissionId);
    if (!prepared || "reconcileAttemptId" in prepared) throw new Error("Expected submission");
    const externalMessageId = crypto.randomUUID();
    await markAccepted(prepared.attemptId, externalMessageId);
    const recipient = row.deliveries.find(item => item.recipient_role === "cc")!;
    await applyCanonicalEvent("pa_mock", null, { id: crypto.randomUUID(), externalMessageId, recipient: recipient.recipient_email, type: "failed", occurredAt: new Date(), metadata: {} });
    const capabilities = providerRegistry("mock").descriptor.capabilities;
    const original = capabilities.envelopeRecipients;
    capabilities.envelopeRecipients = false;
    try {
      await expect(retryMessage(row.id, serviceId, { deliveryIds: [recipient.id], acknowledgeDuplicateRisk: false }, crypto.randomUUID())).rejects.toMatchObject({ code: "UNSUPPORTED_MESSAGE_CAPABILITY" });
      expect((await query<{ count: string }>("SELECT count(*) FROM submissions WHERE message_id=$1", [row.id])).rows[0].count).toBe("1");
    } finally { capabilities.envelopeRecipients = original; }
  });

  it("keeps manual subset retry and stale automatic group work disjoint", async () => {
    const row = await fixture();
    const prepared = await prepareSubmission(row.submissionId);
    if (!prepared || "reconcileAttemptId" in prepared) throw new Error("Expected submission");
    await markDeterminateFailure(prepared.attemptId, { category: "rate_limit", code: "PROVIDER_RATE_LIMITED", message: "Temporary quota" }, true);
    const cc = row.deliveries.find(item => item.recipient_role === "cc")!;
    const retry = await retryMessage(row.id, serviceId, { deliveryIds: [cc.id], acknowledgeDuplicateRisk: false }, crypto.randomUUID());
    expect(retry?.queued).toBe(1);
    const send = vi.spyOn(providerRegistry("mock").sender, "send");
    try {
      // The old group is consumed after its Cc recipient has moved to manual work.
      await processDelivery(job(row.submissionId));
      const queued = (await query<{ id: string }>("SELECT id FROM submissions WHERE message_id=$1 AND status='queued' ORDER BY id", [row.id])).rows;
      expect(queued).toHaveLength(2);
      for (const item of queued) await processDelivery(job(item.id));
      expect(send).toHaveBeenCalledTimes(2);
      const envelopes = send.mock.calls.flatMap(([mail]) => mail.envelopeRecipients!.map(item => item.email));
      expect(envelopes.sort()).toEqual(row.deliveries.map(item => item.recipient_email).sort());
      expect(new Set(envelopes).size).toBe(3);
      for (const [mail] of send.mock.calls) {
        expect(mail.to).toEqual(base.to);
        expect(mail.cc).toEqual(base.cc);
        expect(mail.bcc).toEqual(base.bcc);
      }
      expect((await getMessage(row.id, serviceId))?.outcome).toBe("succeeded");
    } finally { send.mockRestore(); }
  });

  it("cancels all grouped recipients atomically before provider submission", async () => {
    const row = await fixture();
    expect((await cancelMessage(row.id, serviceId))?.canceled).toBe(3);
    const send = vi.spyOn(providerRegistry("mock").sender, "send");
    try {
      await processDelivery(job(row.submissionId));
      expect(send).not.toHaveBeenCalled();
      expect((await getMessage(row.id, serviceId))?.outcome).toBe("canceled");
      expect((await query<{ count: string }>("SELECT count(*) FROM submission_attempts WHERE submission_id=$1", [row.submissionId])).rows[0].count).toBe("0");
    } finally { send.mockRestore(); }
  });

  it("forks an immutable submission after late suppression and sends only its permitted envelope", async () => {
    const email = `late-suppression-${crypto.randomUUID()}@example.net`;
    const input = { ...base, cc: [{ email }] };
    const row = await fixture(input);
    const suppression = await createSuppression({ productId: identity.productId, scope: "product", email, reason: "Late suppression" });
    const send = vi.spyOn(providerRegistry("mock").sender, "send");
    try {
      await processDelivery(job(row.submissionId));
      expect(send).not.toHaveBeenCalled();
      const replacement = (await query<{ id: string }>("SELECT id FROM submissions WHERE message_id=$1 AND status='queued'", [row.id])).rows;
      expect(replacement).toHaveLength(1);
      await processDelivery(job(replacement[0].id));
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].cc).toEqual(input.cc);
      expect(send.mock.calls[0][0].envelopeRecipients?.map(item => item.email).sort()).toEqual([...base.to, ...base.bcc].map(item => item.email).sort());
      const cc = row.deliveries.find(item => item.recipient_role === "cc")!;
      const detail = await getDelivery(cc.id, serviceId);
      expect(detail).toMatchObject({ lifecycle: "failed", compliance: "suppressed", lastError: { code: "RECIPIENT_SUPPRESSED" } });
      expect(detail?.attempts).toHaveLength(0);
      expect((await getMessage(row.id, serviceId))?.outcome).toBe("partially_failed");
    } finally { send.mockRestore(); await query("DELETE FROM suppressions WHERE id=$1", [suppression.id]); }
  });

  it("enforces domain sending grants and rejects unauthorized domains before creating messages", async () => {
    await query("UPDATE service_domain_grants SET send_allowed=false WHERE id=$1", [grantId]);
    try {
      await expect(acceptMessage({ identity, input: base, idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: "SENDER_NOT_AUTHORIZED" });
      await expect(acceptMessage({ identity, input: { ...base, from: { email: "only-this-address@unauthorized.example" } }, idempotencyKey: crypto.randomUUID() })).rejects.toBeInstanceOf(MessageValidationError);
      await query("UPDATE service_domain_grants SET send_allowed=true WHERE id=$1",[grantId]);
      const row = await fixture({ ...base, from: { email: "only-this-address@mail.atlas.test", name: "任意合法显示名称" } });
      expect((await getMessage(row.id, serviceId))?.sender_snapshot.fromEmail).toBe("only-this-address@mail.atlas.test");
    } finally { await query("UPDATE service_domain_grants SET send_allowed=true WHERE id=$1", [grantId]); }
  });

  it("records a service-scoped request problem for an email rejected before a message ID exists", async () => {
    const response = await submitMail(request("/api/v1/messages", { method: "POST", key: crypto.randomUUID(), body: { ...base, from: { email: "unauthorized@foreign.example" } } }));
    expect(response.status).toBe(422);
    const problem = await response.json();
    expect(problem).toMatchObject({ code: "SENDER_NOT_AUTHORIZED", requestId: response.headers.get("x-request-id") });
    const tracked = await inspectRequest(request(`/api/v1/requests/${problem.requestId}`), { params: Promise.resolve({ requestId: problem.requestId }) });
    expect(tracked.status).toBe(200);
    const record = await tracked.json();
    expect(record).toMatchObject({ messageId: null, statusCode: 422, problem: { code: problem.code, requestId: problem.requestId } });
    expect(JSON.stringify(record)).not.toContain(apiKey);
    expect(JSON.stringify(record)).not.toContain(base.text);
  });

  it("exposes normalized provider failure diagnostics and the retry decision through attempts, events and callbacks", async () => {
    const row = await fixture();
    const send = vi.spyOn(providerRegistry("mock").sender, "send").mockRejectedValue(new CanonicalProviderError("Temporary provider quota", "rate_limit", "PROVIDER_RATE_LIMITED", "not_accepted", true, { providerCode: "quota_limit" }));
    try {
      await processDelivery(job(row.submissionId));
      const detail = await getDelivery(row.deliveries[0].id, serviceId);
      expect(detail?.lastError).toMatchObject({ code: "PROVIDER_RATE_LIMITED", message: "Temporary provider quota", stage: "submission", acceptance: "not_accepted", retryable: true, providerCode: "quota_limit", retryDecision: { action: "scheduled" } });
      expect(detail?.attempts[0].error).toMatchObject({ code: "PROVIDER_RATE_LIMITED", providerCode: "quota_limit" });
      const callbacks = (await query<{ payload: { data: { diagnostic?: unknown } } }>("SELECT payload FROM callback_deliveries WHERE endpoint_id=$1 AND payload#>>'{data,messageId}'=$2", [`cb_${suffix}`, row.id])).rows;
      expect(callbacks.some(item => JSON.stringify(item.payload.data.diagnostic)?.includes("PROVIDER_RATE_LIMITED"))).toBe(true);
    } finally { send.mockRestore(); }
  });

  it("provides a failure reason when sender authorization is revoked before any provider attempt", async () => {
    const row = await fixture();
    await query("UPDATE service_domain_grants SET status='disabled' WHERE id=$1", [grantId]);
    try {
      expect(await prepareSubmission(row.submissionId)).toBeNull();
      expect(await getDelivery(row.deliveries[0].id, serviceId)).toBeNull();
      await query("UPDATE service_domain_grants SET status='active' WHERE id=$1",[grantId]);
      const detail = await getDelivery(row.deliveries[0].id, serviceId);
      expect(detail?.attempts).toHaveLength(0);
      expect(detail?.lifecycle).toBe("failed");
      expect(detail?.lastError).toMatchObject({ stage: "authorization", acceptance: "not_accepted", retryable: false });
      expect(detail?.lastError?.message.length).toBeGreaterThan(10);
      expect(detail?.events.some(item => item.data.diagnostic?.code === detail.lastError?.code)).toBe(true);
    } finally { await query("UPDATE service_domain_grants SET status='active' WHERE id=$1", [grantId]); }
  });
});
