import type { Job } from "bullmq";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  acceptMessage,
  cancelMessage,
  DuplicateRiskError,
  getMessage,
  IdempotencyConflictError,
  listMessages,
  MessageValidationError,
  retryMessage
} from "@/modules/core/message/service";
import { applyCanonicalEvent, applySuppressedDelivery, processRawProviderEvent } from "@/modules/core/event/service";
import {
  createSuppression,
  listDeliveries,
  listSenderProfiles,
  listSuppressions,
  removeSuppression
} from "@/modules/core/resources/service";
import { ingestProviderWebhook } from "@/modules/webhooks/ingress";
import {
  addSuppression,
  createDomain,
  createInboundRoute,
  createRoutingPolicy,
  createSenderProfile,
  manualRetryDelivery,
  replayDeadLetters,
  rotateProviderCredential,
  simulateRouting
} from "@/modules/admin/actions";
import { CanonicalProviderError } from "@/modules/providers/contracts";
import { objectStore } from "@/modules/config/object-store";
import { persistInbound } from "@/modules/inbound/service";
import { deadLetterCallback } from "@/modules/callbacks/service";
import { sealSecret } from "@/modules/config/envelope";
import { markAccepted, markDeterminateFailure, markUnknown, markReconciled, getAttemptForReconciliation, prepareSubmission } from "@/modules/core/routing/engine";
import { createMessageSchema, createSuppressionSchema } from "@/lib/contracts";
import { providerRegistry } from "@/modules/providers/registry";
import { processDelivery } from "@/worker/delivery";
import { db, query } from "@/server/database";

const identity = {
  serviceId: "svc_atlas_auth",
  serviceName: "Atlas Auth",
  productId: "prd_atlas",
  product: "Atlas",
  rateLimitPerMinute: 600
};
const request = {
  category: "security",
  to: [{ email: "pipeline@example.net" }],
  subject: "123456 is your Atlas login code",
  html: "<p>Hello Pipeline, your login code is <strong>123456</strong>.</p>",
  text: "Hello Pipeline, your login code is 123456.",
  tags: { purpose: "integration" },
  referenceId: "pipeline-test",
  metadata: { suite: "integration" }
};
const messageIds: string[] = [];
const suppressionEmails: string[] = [];
const inboundIds: string[] = [];
afterAll(async () => {
  await query("UPDATE provider_accounts SET status='active',quota=$2 WHERE id=$1", ["pa_mock", { monthlyLimit: 100000 }]);
  await query("UPDATE routing_targets SET status='active',circuit_open_until=NULL WHERE provider_account_id='pa_mock'");
  for (const id of messageIds) {
    await query("DELETE FROM outbox_events WHERE payload->>'attemptId' IN (SELECT da.id FROM delivery_attempts da JOIN deliveries d ON d.id=da.delivery_id WHERE d.message_id=$1)", [id]);
    await query("DELETE FROM outbox_events WHERE payload->>'callbackDeliveryId' IN (SELECT id FROM callback_deliveries WHERE payload#>>'{data,messageId}'=$1)", [id]);
    await query("DELETE FROM callback_deliveries WHERE payload#>>'{data,messageId}'=$1", [id]);
    await query("DELETE FROM outbox_events WHERE payload->>'deliveryId' IN (SELECT id FROM deliveries WHERE message_id=$1)", [id]);
    await query("DELETE FROM messages WHERE id=$1", [id])
  }
  for (const id of inboundIds) {
    await query("DELETE FROM outbox_events WHERE payload->>'callbackDeliveryId' IN (SELECT id FROM callback_deliveries WHERE inbound_message_id=$1)", [id]);
    await query("DELETE FROM callback_deliveries WHERE inbound_message_id=$1", [id]);
    await query("DELETE FROM inbound_messages WHERE id=$1", [id])
  }
  if (suppressionEmails.length) await query("DELETE FROM suppressions WHERE email_normalized=ANY($1::text[])", [suppressionEmails]);
  await query("DELETE FROM raw_provider_events WHERE provider_event_id LIKE 'fixture-%'");
  await query("DELETE FROM callback_deliveries WHERE event_type='test.dead_letter'");
  await db().end()
});
describe("durable message pipeline", () => {
  it("serializes twenty simultaneous first writes and returns the persisted receipt", async () => {
    const idempotencyKey = `concurrent-${crypto.randomUUID()}`;
    const input = { ...request, to: [{ email: `concurrent-${crypto.randomUUID()}@example.net` }] };
    const receipts = await Promise.all(Array.from({ length: 20 }, () => acceptMessage({ identity, idempotencyKey, input })));
    messageIds.push(receipts[0].message.id);
    expect(new Set(receipts.map(receipt => receipt.message.id)).size).toBe(1);
    expect(new Set(receipts.map(receipt => receipt.message.acceptedAt)).size).toBe(1);
    expect(receipts.filter(receipt => !receipt.duplicate)).toHaveLength(1);
    expect((await query<{ count: string }>("SELECT count(*) FROM deliveries WHERE message_id=$1", [receipts[0].message.id])).rows[0].count).toBe("1");
    const conflicts = await Promise.allSettled(Array.from({ length: 5 }, () => acceptMessage({ identity, idempotencyKey, input: { ...input, subject: "Different content" } })));
    expect(conflicts.every(result => result.status === "rejected" && result.reason instanceof IdempotencyConflictError)).toBe(true);
  });

  it("fences simultaneous workers, preserves sender snapshots, and emits one acceptance callback", async () => {
    const accepted = await acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input: request });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{ id: string }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    await query("UPDATE sender_profiles SET from_name='Changed after acceptance',from_local_part='changed' WHERE id='sp_atlas_security'");
    try {
      const submissions = await Promise.all(Array.from({ length: 8 }, () => prepareSubmission(delivery.id)));
      const claimed = submissions.filter(submission => submission && !("reconcileAttemptId" in submission));
      expect(claimed).toHaveLength(1);
      const submission = claimed[0]!;
      if ("reconcileAttemptId" in submission) throw new Error("Unexpected reconcile work");
      expect(submission.fromName).toBe("Atlas");
      expect(submission.fromEmail).toBe("security@mail.atlas.test");
      const externalId = crypto.randomUUID();
      await Promise.all([markAccepted(submission.attemptId, externalId), markAccepted(submission.attemptId, externalId)]);
      await applyCanonicalEvent("pa_mock", null, { id: crypto.randomUUID(), externalMessageId: externalId, type: "accepted", occurredAt: new Date(), metadata: {} });
      const callbacks = (await query<{ id: string; event_id: string; payload_id: string }>("SELECT c.id,c.delivery_event_id AS event_id,c.payload->>'id' AS payload_id FROM callback_deliveries c JOIN delivery_events e ON e.id=c.delivery_event_id WHERE e.delivery_id=$1 AND e.event_type='accepted'", [delivery.id])).rows;
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0].payload_id).toBe(callbacks[0].event_id);
    } finally { await query("UPDATE sender_profiles SET from_name='Atlas',from_local_part='security' WHERE id='sp_atlas_security'"); }
  });

  it("rechecks suppression at the submission boundary", async () => {
    const email = `late-suppression-${crypto.randomUUID()}@example.net`;
    suppressionEmails.push(email);
    const accepted = await acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input: { ...request, to: [{ email }] } });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{ id: string }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    await addSuppression({ email, scope: "global", reason: "manual" }, "test-suite");
    expect(await prepareSubmission(delivery.id)).toBeNull();
    expect((await query<{ lifecycle_status: string; compliance_status: string }>("SELECT lifecycle_status,compliance_status FROM deliveries WHERE id=$1", [delivery.id])).rows[0]).toEqual({ lifecycle_status: "failed", compliance_status: "suppressed" });
    expect((await retryMessage(accepted.message.id, identity.serviceId, true))?.queued).toBe(0);
  });

  it("keeps unknown outcomes intact after risk authorization and fences the old response", async () => {
    const accepted = await acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input: request });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{ id: string }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    const first = await prepareSubmission(delivery.id);
    if (!first || "reconcileAttemptId" in first) throw new Error("Expected submission");
    await markUnknown(first.attemptId, "Response lost after submission");
    expect(await prepareSubmission(delivery.id)).toEqual({ reconcileAttemptId: first.attemptId });
    await retryMessage(accepted.message.id, identity.serviceId, true);
    expect((await query<{ status: string; outcome_determinate: boolean }>("SELECT status,outcome_determinate FROM delivery_attempts WHERE id=$1", [first.attemptId])).rows[0]).toEqual({ status: "unknown", outcome_determinate: false });
    const second = await prepareSubmission(delivery.id);
    if (!second || "reconcileAttemptId" in second) throw new Error("Expected authorized submission");
    const oldExternalId = crypto.randomUUID();
    await markAccepted(first.attemptId, oldExternalId);
    await applyCanonicalEvent("pa_mock", null, { id: crypto.randomUUID(), externalMessageId: oldExternalId, type: "delivered", occurredAt: new Date(), metadata: {} });
    const historicCallback = (await query<{ payload: { data: { lifecycle: string; attemptId: string } } }>("SELECT c.payload FROM callback_deliveries c JOIN delivery_events e ON e.id=c.delivery_event_id WHERE e.delivery_id=$1 AND e.event_type='delivered'", [delivery.id])).rows[0];
    expect(historicCallback.payload.data).toMatchObject({ lifecycle: "delivered", attemptId: first.attemptId });
    expect((await query<{ lifecycle_status: string; current_attempt_id: string }>("SELECT lifecycle_status,current_attempt_id FROM deliveries WHERE id=$1", [delivery.id])).rows[0]).toEqual({ lifecycle_status: "submitting", current_attempt_id: second.attemptId });
  });

  it("retains early verified events and replays them after verification material is changed", async () => {
    const accepted = await acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input: request });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{ id: string }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    const submission = await prepareSubmission(delivery.id);
    if (!submission || "reconcileAttemptId" in submission) throw new Error("Expected submission");
    const externalMessageId = crypto.randomUUID();
    const received = await ingestProviderWebhook("mock", "test-endpoint", { rawBody: new TextEncoder().encode(JSON.stringify({ id: `fixture-early-${crypto.randomUUID()}`, type: "delivered", externalMessageId, occurredAt: new Date().toISOString() })), headers: { authorization: "Bearer test-webhook-token" } });
    if (received.status !== 202) throw new Error("Expected verified receipt");
    await processRawProviderEvent(received.id);
    expect((await query<{ processed_at: Date | null; processing_error: string }>("SELECT processed_at,processing_error FROM raw_provider_events WHERE id=$1", [received.id])).rows[0].processed_at).toBeNull();
    await markAccepted(submission.attemptId, externalMessageId);
    const verifier = vi.spyOn(providerRegistry("mock").webhook, "verify").mockRejectedValue(new Error("Old verifier must not run"));
    try {
      await query("UPDATE raw_provider_events SET next_attempt_at=now(),received_at=now()-interval '1 day' WHERE id=$1", [received.id]);
      await processRawProviderEvent(received.id);
      expect(verifier).not.toHaveBeenCalled();
      expect((await query<{ lifecycle_status: string }>("SELECT lifecycle_status FROM deliveries WHERE id=$1", [delivery.id])).rows[0].lifecycle_status).toBe("delivered");
    } finally { verifier.mockRestore(); }
  });

  it("applies concurrent same-time facts deterministically and never downgrades engagement", async () => {
    const accepted = await acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input: request });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{ id: string }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    const submission = await prepareSubmission(delivery.id);
    if (!submission || "reconcileAttemptId" in submission) throw new Error("Expected submission");
    const externalMessageId = crypto.randomUUID();
    await markAccepted(submission.attemptId, externalMessageId);
    const occurredAt = new Date(Date.now() + 1000);
    await Promise.all((["bounced", "failed", "delivered", "clicked", "opened", "complained", "unsubscribed"] as const).map(type => applyCanonicalEvent("pa_mock", null, { id: crypto.randomUUID(), externalMessageId, type, occurredAt, metadata: {} })));
    expect((await query<{ lifecycle_status: string; engagement_status: string; compliance_status: string }>("SELECT lifecycle_status,engagement_status,compliance_status FROM deliveries WHERE id=$1", [delivery.id])).rows[0]).toEqual({ lifecycle_status: "bounced", engagement_status: "clicked", compliance_status: "complained" });
    await query("DELETE FROM suppressions WHERE email_normalized=$1", [request.to[0].email]);
  });

  it("bounds deferred delivery and reconciliation without rewriting an unknown fact as failure", async () => {
    const accepted = await acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input: request });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{ id: string }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    const submission = await prepareSubmission(delivery.id);
    if (!submission || "reconcileAttemptId" in submission) throw new Error("Expected submission");
    await markUnknown(submission.attemptId, "Response lost");
    await query("UPDATE delivery_attempts SET reconciliation_count=11,reconcile_after=now() WHERE id=$1", [submission.attemptId]);
    expect(await getAttemptForReconciliation(submission.attemptId)).toBeTruthy();
    await markReconciled(submission.attemptId, "unknown");
    expect((await query<{ status: string; reconcile_after: Date | null; error_code: string }>("SELECT status,reconcile_after,error_code FROM delivery_attempts WHERE id=$1", [submission.attemptId])).rows[0]).toEqual({ status: "unknown", reconcile_after: null, error_code: "reconciliation_exhausted" });
  });

  it("never automatically fails over after an unclassified submission exception", async () => {
    const accepted = await acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input: request });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{ id: string }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    const send = vi.spyOn(providerRegistry("mock").sender, "send").mockRejectedValue(new Error("connection lost after provider accepted"));
    try {
      await processDelivery({ data: { deliveryId: delivery.id } } as Job<{ deliveryId: string }>);
      await processDelivery({ data: { deliveryId: delivery.id } } as Job<{ deliveryId: string }>);
      expect(send).toHaveBeenCalledTimes(1);
      expect((await query<{ lifecycle_status: string }>("SELECT lifecycle_status FROM deliveries WHERE id=$1", [delivery.id])).rows[0].lifecycle_status).toBe("unknown");
    } finally { send.mockRestore(); }
  });

  it("creates canonical failure and callback work for local determinate rejection", async () => {
    const accepted = await acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input: request });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{ id: string }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    const send = vi.spyOn(providerRegistry("mock").sender, "send").mockRejectedValue(new CanonicalProviderError("Explicit rejection", "policy", "policy_rejection", "not_accepted", false));
    try {
      await processDelivery({ data: { deliveryId: delivery.id } } as Job<{ deliveryId: string }>);
      const failures = (await query<{ event_id: string; payload_id: string }>("SELECT e.id AS event_id,c.payload->>'id' AS payload_id FROM delivery_events e JOIN callback_deliveries c ON c.delivery_event_id=e.id WHERE e.delivery_id=$1 AND e.event_type='failed'", [delivery.id])).rows;
      expect(failures).toHaveLength(1);
      expect(failures[0].payload_id).toBe(failures[0].event_id);
    } finally { send.mockRestore(); }
  });

  it("stops route deferral after sixty unsuccessful evaluations", async () => {
    const accepted = await acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input: request });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{ id: string }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    await query("UPDATE deliveries SET defer_count=59 WHERE id=$1", [delivery.id]);
    await query("UPDATE provider_accounts SET status='disabled' WHERE id='pa_mock'");
    try {
      expect(await prepareSubmission(delivery.id)).toBeNull();
      expect((await query<{ lifecycle_status: string; defer_count: number }>("SELECT lifecycle_status,defer_count FROM deliveries WHERE id=$1", [delivery.id])).rows[0]).toEqual({ lifecycle_status: "failed", defer_count: 60 });
      expect(await prepareSubmission(delivery.id)).toBeNull();
    } finally { await query("UPDATE provider_accounts SET status='active' WHERE id='pa_mock'"); }
  });

  it("serializes inbound scanning and persists only one attachment set and callback", async () => {
    const externalMessageId = `inbound-concurrent-${crypto.randomUUID()}`;
    const input = { providerAccountId: "pa_mock", webhookEndpointId: "pwe_mock", rawEventId: null as unknown as string,
      message: { externalMessageId, from: "sender@example.net", to: ["support@mail.atlas.test"], cc: [], bcc: [], subject: "Concurrent inbound", receivedAt: new Date(), attachments: [{ fileName: "test.txt", contentType: "text/plain", content: new Uint8Array([1,2,3]) }] } };
    const store = objectStore();
    const original = store.put.bind(store);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const put = vi.spyOn(store, "put").mockImplementation(async (...args) => { await gate; return original(...args); });
    const first = persistInbound(input);
    try {
      await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
      await expect(persistInbound(input)).rejects.toThrow("another worker");
      release();
      const id = await first;
      inboundIds.push(id);
      expect(await persistInbound(input)).toBe(id);
      expect((await query<{ count: string }>("SELECT count(*) FROM inbound_attachments WHERE inbound_message_id=$1", [id])).rows[0].count).toBe("1");
      expect((await query<{ count: string }>("SELECT count(*) FROM callback_deliveries WHERE inbound_message_id=$1", [id])).rows[0].count).toBe("1");
    } finally { release(); put.mockRestore(); }
  });

  it("does not widen a local product suppression to global scope", async () => {
    const email = `product-suppression-${crypto.randomUUID()}@example.net`;
    suppressionEmails.push(email);
    const suppressions = await Promise.all(Array.from({ length: 20 }, () => createSuppression({ productId: identity.productId, scope: "product", email, reason: "manual" })));
    expect(new Set(suppressions.map(item => item.id)).size).toBe(1);
    const accepted = await acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input: { ...request, to: [{ email }] } });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{ id: string }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    await applySuppressedDelivery(delivery.id);
    expect((await query<{ scope_type: string }>("SELECT scope_type FROM suppressions WHERE email_normalized=$1", [email])).rows.map(row => row.scope_type)).toEqual(["product"]);
  });

  it("stores large verified multipart receipts outside PostgreSQL and restores their binary values without verifying again", async () => {
    const adapter = providerRegistry("mock");
    const eventId = `fixture-large-receipt-${crypto.randomUUID()}`;
    const bytes = new Uint8Array(80_000).fill(7);
    const verify = vi.spyOn(adapter.webhook, "verify").mockResolvedValue({ valid: true, replaySafe: true, providerEventId: eventId, nativeType: "inbound.received", parsed: { id: eventId, type: "inbound.received", attachment: bytes } });
    const receive = vi.spyOn(adapter.inbound!, "receive").mockImplementation(async verified => {
      const parsed = verified.parsed as { attachment: Uint8Array };
      expect(parsed.attachment).toBeInstanceOf(Uint8Array);
      expect(parsed.attachment).toEqual(bytes);
      return { externalMessageId: eventId, from: "sender@example.net", to: ["support@mail.atlas.test"], cc: [], bcc: [], subject: "Binary receipt", receivedAt: new Date(), attachments: [{ fileName: "receipt.bin", contentType: "application/octet-stream", content: parsed.attachment }] };
    });
    try {
      const receipt = await ingestProviderWebhook("mock", "test-endpoint", { rawBody: Buffer.from("{}"), headers: { authorization: "Bearer test-webhook-token" } });
      if (receipt.status !== 202) throw new Error("Expected accepted receipt");
      const stored = (await query<{ verification: { objectKey: string }; security_version: number }>("SELECT verification,security_version FROM raw_provider_events WHERE id=$1", [receipt.id])).rows[0];
      expect(stored.verification.objectKey).toContain(".receipt.json");
      expect(JSON.stringify(stored.verification).length).toBeLessThan(200);
      expect(stored.security_version).toBe(1);
      verify.mockRejectedValue(new Error("Already verified"));
      await processRawProviderEvent(receipt.id);
      expect(receive).toHaveBeenCalledTimes(1);
      const inbound = (await query<{ id: string }>("SELECT id FROM inbound_messages WHERE external_message_id=$1", [eventId])).rows[0];
      inboundIds.push(inbound.id);
      expect((await query<{ count: string }>("SELECT count(*) FROM pending_object_deletions WHERE object_key=$1", [stored.verification.objectKey])).rows[0].count).toBe("0");
    } finally { verify.mockRestore(); receive.mockRestore(); }
  });

  it("stops an authorized resend when reconciliation proves acceptance before a new submission", async () => {
    const accepted = await acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input: request });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{ id: string }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    const submission = await prepareSubmission(delivery.id);
    if (!submission || "reconcileAttemptId" in submission) throw new Error("Expected submission");
    await markUnknown(submission.attemptId, "Response lost");
    await retryMessage(accepted.message.id, identity.serviceId, true);
    await markReconciled(submission.attemptId, "accepted");
    expect((await query<{ lifecycle_status: string }>("SELECT lifecycle_status FROM deliveries WHERE id=$1", [delivery.id])).rows[0].lifecycle_status).toBe("accepted");
    expect(await prepareSubmission(delivery.id)).toBeNull();
    // The original response can still provide a native ID after conclusive reconciliation.
    const externalId = crypto.randomUUID();
    await markAccepted(submission.attemptId, externalId);
    expect((await query<{ external_message_id: string }>("SELECT external_message_id FROM delivery_attempts WHERE id=$1", [submission.attemptId])).rows[0].external_message_id).toBe(externalId);
    expect((await query<{ count: string }>("SELECT count(*) FROM delivery_events WHERE delivery_id=$1 AND event_type='accepted'", [delivery.id])).rows[0].count).toBe("1");
  });

  it("resumes bounded automatic work only after reconciliation explicitly proves non-acceptance", async () => {
    const accepted = await acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input: request });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{ id: string }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    const submission = await prepareSubmission(delivery.id);
    if (!submission || "reconcileAttemptId" in submission) throw new Error("Expected submission");
    await markUnknown(submission.attemptId, "Response lost");
    await markReconciled(submission.attemptId, "not_accepted");
    expect((await query<{ lifecycle_status: string }>("SELECT lifecycle_status FROM deliveries WHERE id=$1", [delivery.id])).rows[0].lifecycle_status).toBe("deferred");
    expect((await query<{ status: string; outcome_determinate: boolean }>("SELECT status,outcome_determinate FROM delivery_attempts WHERE id=$1", [submission.attemptId])).rows[0]).toEqual({ status: "failed", outcome_determinate: true });
    expect((await query<{ count: string }>("SELECT count(*) FROM outbox_events WHERE aggregate_id=$1 AND event_type='delivery.requested' AND available_at>now()", [delivery.id])).rows[0].count).toBe("1");
  });

  it("keeps public capabilities and API contracts aligned with implemented behavior", () => {
    for (const type of ["resend", "ses", "sendgrid", "mailgun", "postmark", "mock"] as const) {
      const adapter = providerRegistry(type);
      expect(adapter.descriptor.capabilities.domainManagement).toBe(Boolean(adapter.identity));
      expect(adapter.descriptor.capabilities.attachments).toBe(false);
      expect(adapter.descriptor.capabilities.scheduling).toBe(false);
    }
    expect(createMessageSchema.safeParse({
      category: "security",
      to: [{ email: "Person@example.test" }, { email: "person@example.test" }],
      subject: "Duplicate recipient",
      text: "Duplicate recipient"
    }).success).toBe(false);
    expect(createSuppressionSchema.safeParse({
      email: "person@example.test",
      scope: "product",
      listId: "newsletter",
      reason: "manual"
    }).success).toBe(false);
  });

  it("applies routing defaults and rejects invalid admin resource relationships before configuration is stored", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const foreignProductId = `prd_integrity_${suffix}`;
    const foreignServiceId = `svc_integrity_${suffix}`;
    const manualAccountId = `pa_manual_${suffix}`;
    const mailgunAccountId = `pa_mailgun_${suffix}`;
    let manualDomainId: string | undefined;
    const policyId = await createRoutingPolicy({
      name: `Integrity policy ${suffix}`,
      serviceId: "svc_atlas_auth",
      domainId: "sd_atlas",
      category: `integrity-${suffix}`,
      targets: [{ accountId: "pa_mock", identityId: "pi_atlas_mock" }]
    }, "test-suite");
    let inboundRouteId: string | undefined;
    try {
      expect((await query<{
        product_id: string;
        service_id: string;
        sending_domain_id: string;
        policy_priority: number;
        target_priority: number;
        weight: number;
        rate_limit_per_minute: number
      }>(`SELECT rp.product_id,rp.service_id,rp.sending_domain_id,rp.priority AS policy_priority,
        rt.priority AS target_priority,rt.weight,rt.rate_limit_per_minute
        FROM routing_policies rp JOIN routing_targets rt ON rt.policy_id=rp.id WHERE rp.id=$1`, [policyId])).rows[0]).toEqual({
        product_id: "prd_atlas",
        service_id: "svc_atlas_auth",
        sending_domain_id: "sd_atlas",
        policy_priority: 100,
        target_priority: 100,
        weight: 100,
        rate_limit_per_minute: 1000
      });
      await expect(createRoutingPolicy({
        name: `No targets ${suffix}`,
        productId: "prd_atlas",
        domainId: "sd_atlas",
        targets: []
      }, "test-suite")).rejects.toThrow(/At least one routing target/);
      await expect(createRoutingPolicy({
        name: `Wrong account ${suffix}`,
        productId: "prd_atlas",
        domainId: "sd_atlas",
        targets: [{ accountId: "pa_other", identityId: "pi_atlas_mock" }]
      }, "test-suite")).rejects.toThrow(/identity owned by its provider account/);
      await expect(createDomain({
        domain: `missing-account-${suffix}.example.test`,
        accountIds: []
      }, "test-suite")).rejects.toThrow(/Select at least one provider account/);
      const manualCredential = sealSecret({ type: "sendgrid", apiKey: "SG.test-api-key" }, manualAccountId, 1);
      await query("INSERT INTO provider_accounts(id,type,name,status,public_config) VALUES ($1,'sendgrid',$2,'active',$3)", [manualAccountId, `Manual provider ${suffix}`, { region: "global" }]);
      await query("INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by) VALUES ($1,$2,1,$3,$4,$5,'test-suite')", [
        `pc_manual_${suffix}`, manualAccountId, manualCredential.secretCiphertext, manualCredential.encryptedDek, manualCredential.keyVersion
      ]);
      const manualDomain = await createDomain({
        domain: `verified-${suffix}.example.test`,
        accountIds: [manualAccountId]
      }, "test-suite");
      manualDomainId = manualDomain.domainId;
      const manualIdentity = (await query<{ id: string; status: string; external_identity_id: string | null }>("SELECT id,status,external_identity_id FROM provider_identities WHERE sending_domain_id=$1", [manualDomainId])).rows[0];
      expect(manualIdentity).toMatchObject({
        status: "verified",
        external_identity_id: null
      });
      await expect(createRoutingPolicy({
        name: `Cross-domain target ${suffix}`,
        productId: "prd_atlas",
        domainId: "sd_atlas",
        targets: [{ accountId: manualAccountId, identityId: manualIdentity.id }]
      }, "test-suite")).rejects.toThrow(/selected sending domain/);
      expect((await simulateRouting({ domainId: manualDomainId, productId: "prd_atlas", category: "security" })).candidates).toEqual([]);
      const mailgunCredential = sealSecret({ type: "mailgun", apiKey: "key-mailgun-test" }, mailgunAccountId, 1);
      await query("INSERT INTO provider_accounts(id,type,name,status,public_config) VALUES ($1,'mailgun',$2,'active',$3)", [mailgunAccountId, `Mailgun provider ${suffix}`, {
        region: "us",
        sendingDomain: `configured-${suffix}.example.test`
      }]);
      await query("INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by) VALUES ($1,$2,1,$3,$4,$5,'test-suite')", [
        `pc_mailgun_${suffix}`, mailgunAccountId, mailgunCredential.secretCiphertext, mailgunCredential.encryptedDek, mailgunCredential.keyVersion
      ]);
      await expect(createDomain({
        domain: `different-${suffix}.example.test`,
        accountIds: [mailgunAccountId]
      }, "test-suite")).rejects.toThrow(/Mailgun account sends through/);
      await rotateProviderCredential(manualAccountId, { apiKey: "SG.replacement-api-key" }, "test-suite");
      expect((await query<{ status: string; health: { status: string } }>("SELECT status,health FROM provider_accounts WHERE id=$1", [manualAccountId])).rows[0]).toEqual({
        status: "degraded",
        health: expect.objectContaining({ status: "unknown" })
      });
      await expect(createSenderProfile({
        productId: "prd_atlas",
        domainId: "sd_atlas",
        name: "Atlas Security",
        fromName: "Atlas",
        fromLocalPart: "different-local-part",
        category: "transactional"
      }, "test-suite")).rejects.toThrow(/already exists/);
      await expect(addSuppression({
        email: `global-${suffix}@example.test`,
        scope: "global",
        productId: "prd_atlas",
        reason: "manual"
      }, "test-suite")).rejects.toThrow(/Global suppressions cannot target/);

      await query("INSERT INTO products(id,name) VALUES ($1,$2)", [foreignProductId, "Integrity product"]);
      await query("INSERT INTO services(id,product_id,name) VALUES ($1,$2,$3)", [foreignServiceId, foreignProductId, "Integrity service"]);
      await expect(createInboundRoute({
        webhookEndpointId: "pwe_mock",
        domainId: "sd_atlas",
        productId: "prd_atlas",
        serviceId: foreignServiceId,
        localPartPattern: `integrity-${suffix}`
      }, "test-suite")).rejects.toThrow(/does not belong to the selected product/);
      inboundRouteId = await createInboundRoute({
        webhookEndpointId: "pwe_mock",
        domainId: "sd_atlas",
        productId: "prd_atlas",
        serviceId: "svc_atlas_auth",
        callbackId: "cb_atlas_local",
        localPartPattern: `integrity-${suffix}`
      }, "test-suite");
      expect((await query<{ service_id: string; callback_endpoint_id: string }>("SELECT service_id,callback_endpoint_id FROM inbound_routes WHERE id=$1", [inboundRouteId])).rows[0]).toEqual({
        service_id: "svc_atlas_auth",
        callback_endpoint_id: "cb_atlas_local"
      });
      await expect(query("INSERT INTO routing_policies(id,name,product_id,service_id,sending_domain_id) VALUES ($1,$2,$3,$4,$5)", [
        `rp_cross_${suffix}`, "Cross-product route", "prd_atlas", foreignServiceId, "sd_atlas"
      ])).rejects.toThrow();
      await expect(query("INSERT INTO suppressions(id,scope_type,product_id,email_normalized,reason,source) VALUES ($1,'global',$2,$3,'manual','test')", [
        `sup_cross_${suffix}`, "prd_atlas", `scope-${suffix}@example.test`
      ])).rejects.toThrow();
    } finally {
      if (inboundRouteId) await query("DELETE FROM inbound_routes WHERE id=$1", [inboundRouteId]);
      if (manualDomainId) await query("DELETE FROM sending_domains WHERE id=$1", [manualDomainId]);
      await query("DELETE FROM provider_accounts WHERE id=$1", [mailgunAccountId]);
      await query("DELETE FROM provider_accounts WHERE id=$1", [manualAccountId]);
      await query("DELETE FROM routing_policies WHERE id=$1", [policyId]);
      await query("DELETE FROM products WHERE id=$1", [foreignProductId]);
    }
  });

  it("defensively rejects duplicated recipients for direct server callers", async () => {
    await expect(acceptMessage({
      identity,
      idempotencyKey: `duplicate-${crypto.randomUUID()}`,
      input: {
        ...request,
        to: [{ email: "Person@example.test" }, { email: "person@example.test" }]
      }
    })).rejects.toBeInstanceOf(MessageValidationError);
  });

  it("writes the message, recipient delivery, and outbox atomically and replays idempotently", async () => {
    const key = `pipeline-${crypto.randomUUID()}`;
    const first = await acceptMessage({ identity, idempotencyKey: key, input: request });
    messageIds.push(first.message.id);
    const replay = await acceptMessage({ identity, idempotencyKey: key, input: request });
    expect(replay.duplicate).toBe(true);
    expect(replay.message.id).toBe(first.message.id);
    const state = await query<{
      deliveries: string;
      outbox: string
    }>(`SELECT (SELECT count(*) FROM deliveries WHERE message_id=$1) deliveries,(SELECT count(*) FROM outbox_events WHERE payload->>'deliveryId' IN (SELECT id FROM deliveries WHERE message_id=$1)) outbox`, [first.message.id]);
    expect(Number(state.rows[0].deliveries)).toBe(1);
    expect(Number(state.rows[0].outbox)).toBe(1);
    await expect(acceptMessage({
      identity,
      idempotencyKey: key,
      input: { ...request, subject: "999999 is your Atlas login code" }
    })).rejects.toBeInstanceOf(IdempotencyConflictError)
  });
  it("persists final content and exposes service-scoped message and delivery collections", async () => {
    const referenceId = `resources-${crypto.randomUUID()}`;
    const accepted = await acceptMessage({
      identity,
      idempotencyKey: `resources-${crypto.randomUUID()}`,
      input: { ...request, referenceId, replyTo: "reply@example.net" }
    });
    messageIds.push(accepted.message.id);
    const detail = await getMessage(accepted.message.id, identity.serviceId);
    expect(detail).toMatchObject({
      subject: request.subject,
      html_body: request.html,
      text_body: request.text,
      category: request.category,
      reply_to: "reply@example.net",
      provider_tags: request.tags
    });
    expect(await getMessage(accepted.message.id, "svc_nova_app")).toBeNull();
    const messages = await listMessages(identity.serviceId, { limit: 10, referenceId });
    expect(messages.data.map(item => item.id)).toContain(accepted.message.id);
    const deliveries = await listDeliveries(identity.serviceId, { limit: 10, messageId: accepted.message.id });
    expect(deliveries.data).toHaveLength(1);
    expect(deliveries.data[0]).toMatchObject({ subject: request.subject, category: request.category })
  });
  it("cancels queued deliveries before any provider attempt is created", async () => {
    const accepted = await acceptMessage({
      identity,
      idempotencyKey: `cancel-${crypto.randomUUID()}`,
      input: { ...request, to: [{ email: `cancel-${crypto.randomUUID()}@example.net` }] }
    });
    messageIds.push(accepted.message.id);
    expect(await cancelMessage(accepted.message.id, "svc_nova_app")).toBeNull();
    const result = await cancelMessage(accepted.message.id, identity.serviceId);
    expect(result?.canceled).toBe(1);
    const delivery = (await query<{
      id: string
    }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    await processDelivery({ data: { deliveryId: delivery.id } } as Job<{ deliveryId: string }>);
    expect(Number((await query<{
      count: string
    }>("SELECT count(*) FROM delivery_attempts WHERE delivery_id=$1", [delivery.id])).rows[0].count)).toBe(0);
    expect((await getMessage(accepted.message.id, identity.serviceId))?.status).toBe("canceled")
  });
  it("requires duplicate-risk acknowledgement before retrying an unknown outcome", async () => {
    const accepted = await acceptMessage({
      identity,
      idempotencyKey: `service-retry-${crypto.randomUUID()}`,
      input: { ...request, to: [{ email: `service-retry-${crypto.randomUUID()}@example.net` }] }
    });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{
      id: string
    }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    expect(await prepareSubmission(delivery.id)).toBeTruthy();
    await query("UPDATE delivery_attempts SET submission_deadline_at=now()-interval '1 second' WHERE delivery_id=$1", [delivery.id]);
    expect(await prepareSubmission(delivery.id)).toHaveProperty("reconcileAttemptId");
    await expect(retryMessage(accepted.message.id, identity.serviceId, false)).rejects.toBeInstanceOf(DuplicateRiskError);
    expect((await retryMessage(accepted.message.id, identity.serviceId, true))?.queued).toBe(1);
    const attempt = (await query<{ status: string; authorized: string | null }>(`SELECT status,retry_authorized_at AS authorized
      FROM delivery_attempts WHERE delivery_id=$1 ORDER BY attempt_number DESC LIMIT 1`, [delivery.id])).rows[0];
    expect(attempt.status).toBe("unknown");
    expect(attempt.authorized).toBeTruthy()
  });
  it("manages product-scoped suppressions and discovers sender profiles", async () => {
    const email = `suppression-${crypto.randomUUID()}@example.net`;
    suppressionEmails.push(email);
    const created = await createSuppression({
      productId: identity.productId,
      email,
      scope: "product",
      reason: "integration_test"
    });
    expect(created.duplicate).toBe(false);
    expect((await createSuppression({
      productId: identity.productId,
      email,
      scope: "product",
      reason: "integration_test"
    })).duplicate).toBe(true);
    expect(await listSuppressions("prd_nova", email)).toHaveLength(0);
    expect(await listSuppressions(identity.productId, email)).toHaveLength(1);
    expect(await removeSuppression(created.id, "prd_nova")).toBeNull();
    expect(await removeSuppression(created.id, identity.productId)).toEqual({ id: created.id });
    expect((await listSenderProfiles(identity.productId)).some(sender => sender.category === request.category)).toBe(true)
  });
  it("is safe under duplicate worker consumption", async () => {
    const accepted = await acceptMessage({
      identity,
      idempotencyKey: `worker-${crypto.randomUUID()}`,
      input: { ...request, to: [{ email: "worker@example.net" }] }
    });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{
      id: string
    }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    const job = { data: { deliveryId: delivery.id } } as Job<{ deliveryId: string }>;
    await processDelivery(job);
    await processDelivery(job);
    const attempts = await query<{
      count: string
    }>("SELECT count(*) FROM delivery_attempts WHERE delivery_id=$1", [delivery.id]);
    expect(Number(attempts.rows[0].count)).toBe(1);
    const status = await query<{
      lifecycle_status: string
    }>("SELECT lifecycle_status FROM deliveries WHERE id=$1", [delivery.id]);
    expect(status.rows[0].lifecycle_status).toBe("delivered")
  });
  it("deduplicates provider ingress and preserves a newer lifecycle event", async () => {
    const accepted = await acceptMessage({
      identity,
      idempotencyKey: `events-${crypto.randomUUID()}`,
      input: { ...request, to: [{ email: "events@example.net" }] }
    });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{
      id: string
    }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    await processDelivery({ data: { deliveryId: delivery.id } } as Job<{ deliveryId: string }>);
    const attempt = (await query<{
      external_message_id: string
    }>("SELECT external_message_id FROM delivery_attempts WHERE delivery_id=$1", [delivery.id])).rows[0];
    const now = new Date();
    await applyCanonicalEvent("pa_mock", null, {
      id: "delivered-new",
      externalMessageId: attempt.external_message_id,
      type: "delivered",
      occurredAt: now,
      metadata: {}
    });
    await applyCanonicalEvent("pa_mock", null, {
      id: "deferred-old",
      externalMessageId: attempt.external_message_id,
      type: "deferred",
      occurredAt: new Date(now.getTime() - 60_000),
      metadata: {}
    });
    expect((await query<{
      lifecycle_status: string
    }>("SELECT lifecycle_status FROM deliveries WHERE id=$1", [delivery.id])).rows[0].lifecycle_status).toBe("delivered");
    const payload = {
      id: `fixture-${crypto.randomUUID()}`,
      type: "delivered",
      externalMessageId: attempt.external_message_id,
      occurredAt: now.toISOString(),
      recipient: "events@example.net"
    };
    const raw = new TextEncoder().encode(JSON.stringify(payload));
    const first = await ingestProviderWebhook("mock", "test-endpoint", {
      rawBody: raw,
      headers: { authorization: "Bearer test-webhook-token" }
    });
    const second = await ingestProviderWebhook("mock", "test-endpoint", {
      rawBody: raw,
      headers: { authorization: "Bearer test-webhook-token" }
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    if (second.status !== 202) throw new Error("Expected accepted duplicate");
    expect(second.duplicate).toBe(true)
  });
  it("moves exhausted callbacks to dead letter and can replay them", async () => {
    const id = `cbx_test_${crypto.randomUUID()}`;
    await query("INSERT INTO callback_deliveries(id,endpoint_id,event_type,payload) VALUES ($1,'cb_atlas_local','test.dead_letter',$2)", [id, {
      id: "event-test",
      type: "test.dead_letter",
      data: {}
    }]);
    await deadLetterCallback(id, "fixture failure");
    expect((await query<{
      status: string
    }>("SELECT status FROM callback_deliveries WHERE id=$1", [id])).rows[0].status).toBe("dead_letter");
    const count = await replayDeadLetters("test-suite");
    expect(count).toBeGreaterThanOrEqual(1);
    expect((await query<{
      status: string
    }>("SELECT status FROM callback_deliveries WHERE id=$1", [id])).rows[0].status).toBe("pending")
  });
  it("defers delivery when the provider quota is exhausted", async () => {
    const accepted = await acceptMessage({
      identity,
      idempotencyKey: `quota-${crypto.randomUUID()}`,
      input: { ...request, to: [{ email: `quota-${crypto.randomUUID()}@example.net` }] }
    });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{
      id: string
    }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    await query("UPDATE provider_accounts SET quota=$2 WHERE id=$1", ["pa_mock", { monthlyLimit: 0 }]);
    try {
      await processDelivery({ data: { deliveryId: delivery.id } } as Job<{ deliveryId: string }>);
      expect((await query<{
        lifecycle_status: string
      }>("SELECT lifecycle_status FROM deliveries WHERE id=$1", [delivery.id])).rows[0].lifecycle_status).toBe("deferred");
      expect(Number((await query<{
        count: string
      }>("SELECT count(*) FROM delivery_attempts WHERE delivery_id=$1", [delivery.id])).rows[0].count)).toBe(0)
    } finally {
      await query("UPDATE provider_accounts SET quota=$2 WHERE id=$1", ["pa_mock", { monthlyLimit: 100000 }])
    }
  });
  it("moves an interrupted submission to reconciliation without sending again", async () => {
    const accepted = await acceptMessage({
      identity,
      idempotencyKey: `interrupted-${crypto.randomUUID()}`,
      input: { ...request, to: [{ email: `interrupted-${crypto.randomUUID()}@example.net` }] }
    });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{
      id: string
    }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    const first = await prepareSubmission(delivery.id);
    expect(first && !("reconcileAttemptId" in first)).toBe(true);
    expect(await prepareSubmission(delivery.id)).toBeNull();
    await query("UPDATE delivery_attempts SET submission_deadline_at=now()-interval '1 second' WHERE delivery_id=$1", [delivery.id]);
    const second = await prepareSubmission(delivery.id);
    expect(second && "reconcileAttemptId" in second).toBe(true);
    expect((await query<{
      lifecycle_status: string
    }>("SELECT lifecycle_status FROM deliveries WHERE id=$1", [delivery.id])).rows[0].lifecycle_status).toBe("unknown")
  });
  it("does not let an operator bypass hard-bounce suppression", async () => {
    const email = `bounce-${crypto.randomUUID()}@example.net`;
    suppressionEmails.push(email);
    const accepted = await acceptMessage({
      identity,
      idempotencyKey: `bounce-${crypto.randomUUID()}`,
      input: { ...request, to: [{ email }] }
    });
    messageIds.push(accepted.message.id);
    const delivery = (await query<{
      id: string
    }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
    await processDelivery({ data: { deliveryId: delivery.id } } as Job<{ deliveryId: string }>);
    expect((await query<{
      lifecycle_status: string
    }>("SELECT lifecycle_status FROM deliveries WHERE id=$1", [delivery.id])).rows[0].lifecycle_status).toBe("bounced");
    expect(await manualRetryDelivery(delivery.id, true, "test-suite")).toMatchObject({ queued: false, reason: "suppressed" });
    await processDelivery({ data: { deliveryId: delivery.id } } as Job<{ deliveryId: string }>);
    expect(Number((await query<{
      count: string
    }>("SELECT count(*) FROM delivery_attempts WHERE delivery_id=$1", [delivery.id])).rows[0].count)).toBe(1)
  });
  it("opens the target circuit after consecutive retryable failures", async () => {
    const created: string[] = [];
    try {
      for (let index = 0; index < 5; index += 1) {
        const accepted = await acceptMessage({
          identity,
          idempotencyKey: `circuit-${crypto.randomUUID()}`,
          input: { ...request, to: [{ email: `circuit-${index}-${crypto.randomUUID()}@example.net` }] }
        });
        messageIds.push(accepted.message.id);
        created.push(accepted.message.id);
        const delivery = (await query<{
          id: string
        }>("SELECT id FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
        const submission = await prepareSubmission(delivery.id);
        if (!submission || "reconcileAttemptId" in submission) throw new Error("Expected a routable submission");
        await markDeterminateFailure(submission.attemptId, {
          category: "provider",
          code: "fixture_unavailable",
          message: "Fixture outage"
        }, true)
      }
      expect((await query<{
        status: string
      }>(`SELECT rt.status FROM routing_targets rt JOIN routing_policies rp ON rp.id=rt.policy_id
          WHERE rp.product_id='prd_atlas' ORDER BY rp.priority,rt.priority LIMIT 1`)).rows[0].status).toBe("circuit_open")
    } finally {
      await query(`UPDATE routing_targets SET status='active',circuit_open_until=NULL
        WHERE policy_id IN (SELECT id FROM routing_policies WHERE product_id='prd_atlas')`)
    }
  });
  it("accepts, sanitizes, deduplicates, and routes inbound mail while outbound is disabled", async () => {
    const eventId = `fixture-inbound-${crypto.randomUUID()}`;
    const externalMessageId = `mock-inbound-${crypto.randomUUID()}`;
    const payload = {
      id: eventId,
      type: "inbound.received",
      externalMessageId,
      from: "External Sender <sender@example.net>",
      to: ["support@mail.atlas.test"],
      subject: "Inbound fixture",
      html: "<p>Safe</p><script>alert(1)</script>",
      text: "Safe"
    };
    const raw = new TextEncoder().encode(JSON.stringify(payload));
    await query("UPDATE provider_accounts SET status='disabled' WHERE id='pa_mock'");
    try {
      const accepted = await ingestProviderWebhook("mock", "test-endpoint", {
        rawBody: raw,
        headers: { authorization: "Bearer test-webhook-token" }
      });
      if (accepted.status !== 202) throw new Error("Expected the inbound webhook to be accepted");
      const stored = (await query<{
        headers: Record<string, string>
      }>("SELECT headers FROM raw_provider_events WHERE id=$1", [accepted.id])).rows[0];
      expect(stored.headers.authorization).toBe("[redacted]");
      await processRawProviderEvent(accepted.id);
      const inbound = (await query<{
        id: string;
        status: string;
        sanitized_html: string
      }>("SELECT id,status,sanitized_html FROM inbound_messages WHERE provider_account_id='pa_mock' AND external_message_id=$1", [externalMessageId])).rows[0];
      inboundIds.push(inbound.id);
      expect(inbound.status).toBe("ready");
      expect(inbound.sanitized_html).toBe("<p>Safe</p>");
      const duplicate = await ingestProviderWebhook("mock", "test-endpoint", {
        rawBody: raw,
        headers: { authorization: "Bearer test-webhook-token" }
      });
      if (duplicate.status !== 202) throw new Error("Expected accepted duplicate");
      expect(duplicate.duplicate).toBe(true)
    } finally {
      await query("UPDATE provider_accounts SET status='active' WHERE id='pa_mock'")
    }
  });
});
