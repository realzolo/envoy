import type { Job } from "bullmq";
import { afterAll, describe, expect, it } from "vitest";
import { acceptMessage, IdempotencyConflictError } from "@/modules/core/message/service";
import { applyCanonicalEvent, processRawProviderEvent } from "@/modules/core/event/service";
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
  template: "auth.login-code",
  to: [{ email: "pipeline@example.net" }],
  locale: "en-US",
  variables: { code: "123456", expiresInMinutes: 10, userName: "Pipeline", productName: "Atlas" },
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
      input: { ...request, variables: { ...request.variables, code: "999999" } }
    })).rejects.toBeInstanceOf(IdempotencyConflictError)
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
    const first = await ingestProviderWebhook("mock", "mock-local-endpoint", {
      rawBody: raw,
      headers: { authorization: "Bearer local-mock-webhook" }
    });
    const second = await ingestProviderWebhook("mock", "mock-local-endpoint", {
      rawBody: raw,
      headers: { authorization: "Bearer local-mock-webhook" }
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
      }>("SELECT status FROM routing_targets WHERE id='rt_tpl_atlas_login'")).rows[0].status).toBe("circuit_open")
    } finally {
      await query("UPDATE routing_targets SET status='active',circuit_open_until=NULL WHERE id='rt_tpl_atlas_login'")
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
      to: ["support@mail.atlas.example"],
      subject: "Inbound fixture",
      html: "<p>Safe</p><script>alert(1)</script>",
      text: "Safe"
    };
    const raw = new TextEncoder().encode(JSON.stringify(payload));
    await query("UPDATE provider_accounts SET status='disabled' WHERE id='pa_mock'");
    try {
      const accepted = await ingestProviderWebhook("mock", "mock-local-endpoint", {
        rawBody: raw,
        headers: { authorization: "Bearer local-mock-webhook" }
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
      const duplicate = await ingestProviderWebhook("mock", "mock-local-endpoint", {
        rawBody: raw,
        headers: { authorization: "Bearer local-mock-webhook" }
      });
      expect(duplicate.duplicate).toBe(true)
    } finally {
      await query("UPDATE provider_accounts SET status='active' WHERE id='pa_mock'")
    }
  });
});
