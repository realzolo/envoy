import type { Job } from "bullmq";
import { afterAll, describe, expect, it } from "vitest";
import {
  acceptMessage,
  cancelMessage,
  DuplicateRiskError,
  getMessage,
  IdempotencyConflictError,
  listMessages,
  retryMessage
} from "@/modules/core/message/service";
import { applyCanonicalEvent, processRawProviderEvent } from "@/modules/core/event/service";
import {
  createSuppression,
  listDeliveries,
  listSenderProfiles,
  listSuppressions,
  removeSuppression
} from "@/modules/core/resources/service";
import { ingestProviderWebhook } from "@/modules/webhooks/ingress";
import { manualRetryDelivery, replayDeadLetters } from "@/modules/admin/actions";
import { deadLetterCallback } from "@/modules/callbacks/service";
import { markDeterminateFailure, prepareSubmission } from "@/modules/core/routing/engine";
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
    expect(await prepareSubmission(delivery.id)).toHaveProperty("reconcileAttemptId");
    await expect(retryMessage(accepted.message.id, identity.serviceId, false)).rejects.toBeInstanceOf(DuplicateRiskError);
    expect((await retryMessage(accepted.message.id, identity.serviceId, true))?.queued).toBe(1);
    const attempt = (await query<{ status: string; authorized: string | null }>(`SELECT status,routing_snapshot->>'serviceRetryAuthorizedAt' AS authorized
      FROM delivery_attempts WHERE delivery_id=$1 ORDER BY attempt_number DESC LIMIT 1`, [delivery.id])).rows[0];
    expect(attempt.status).toBe("failed");
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
    const second = await prepareSubmission(delivery.id);
    expect(second && "reconcileAttemptId" in second).toBe(true);
    expect((await query<{
      lifecycle_status: string
    }>("SELECT lifecycle_status FROM deliveries WHERE id=$1", [delivery.id])).rows[0].lifecycle_status).toBe("unknown")
  });
  it("creates a new attempt after an operator retries a bounced delivery", async () => {
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
    await manualRetryDelivery(delivery.id, false, "test-suite");
    await processDelivery({ data: { deliveryId: delivery.id } } as Job<{ deliveryId: string }>);
    expect(Number((await query<{
      count: string
    }>("SELECT count(*) FROM delivery_attempts WHERE delivery_id=$1", [delivery.id])).rows[0].count)).toBe(2)
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
      expect(duplicate.duplicate).toBe(true)
    } finally {
      await query("UPDATE provider_accounts SET status='active' WHERE id='pa_mock'")
    }
  });
});
