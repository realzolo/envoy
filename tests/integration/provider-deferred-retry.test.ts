import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMessageSchema } from "@/lib/contracts";
import { acceptMessage, getDeliveryRetryEligibility, getMessage, MessageValidationError, retryMessage } from "@/modules/core/message/service";
import { applyCanonicalEvent } from "@/modules/core/event/service";
import { markAccepted, markUnknown, prepareSubmission } from "@/modules/core/routing/engine";
import { db, query } from "@/server/database";

const identity = { serviceId: `svc_deferred_${crypto.randomUUID()}`, serviceName: "Deferred retry audit", productId: "prd_atlas", product: "Atlas", rateLimitPerMinute: 600 };
const created: string[] = [];
beforeAll(async () => {
  await query("INSERT INTO services(id,product_id,name) VALUES ($1,'prd_atlas',$2)", [identity.serviceId, identity.serviceName]);
  await query("INSERT INTO sender_grants(id,product_id,service_id,sending_domain_id) VALUES ($1,'prd_atlas',$2,'sd_atlas')", [`grant_${identity.serviceId}`,identity.serviceId]);
});
afterAll(async () => {
  for (const id of created) {
    await query("DELETE FROM outbox_events WHERE payload->>'submissionId' IN (SELECT id FROM submissions WHERE message_id=$1) OR payload->>'attemptId' IN (SELECT a.id FROM submission_attempts a JOIN submissions s ON s.id=a.submission_id WHERE s.message_id=$1)", [id]);
    await query("DELETE FROM suppressions WHERE email_normalized IN (SELECT lower(recipient_email) FROM deliveries WHERE message_id=$1)", [id]);
    await query("DELETE FROM messages WHERE id=$1", [id]);
  }
  await query("DELETE FROM services WHERE id=$1", [identity.serviceId]);
  await db().end();
});

describe("provider-owned recipient retries", () => {
  it("prevents acknowledged manual retry while the accepted provider is still retrying a deferred recipient", async () => {
    const input = createMessageSchema.parse({ category: "security", from: { email: "native@mail.atlas.test" }, to: [{ email: `deferred-${crypto.randomUUID()}@example.net` }], text: "Provider managed delivery" });
    const accepted = await acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input });
    created.push(accepted.message.id);
    const submission = (await query<{ id: string }>("SELECT id FROM submissions WHERE message_id=$1", [accepted.message.id])).rows[0];
    const prepared = await prepareSubmission(submission.id);
    if (!prepared || "reconcileAttemptId" in prepared) throw new Error("Expected a prepared submission");
    const externalId = crypto.randomUUID();
    await markAccepted(prepared.attemptId, externalId);
    await applyCanonicalEvent("pa_mock", null, { id: crypto.randomUUID(), externalMessageId: externalId, recipient: input.to[0].email, type: "deferred", occurredAt: new Date(Date.now()+1000), metadata: { reason: "Recipient server temporarily unavailable" } });
    const delivery = (await getMessage(accepted.message.id, identity.serviceId))!.deliveries[0];
    expect(delivery.lifecycle_status).toBe("deferred");
    expect(await getDeliveryRetryEligibility(delivery.id)).toMatchObject({ allowed: false, reason: "provider_delivery_pending" });
    await expect(retryMessage(accepted.message.id, identity.serviceId, { deliveryIds: [delivery.id], acknowledgeDuplicateRisk: true }, crypto.randomUUID())).rejects.toBeInstanceOf(MessageValidationError);
    const result = await retryMessage(accepted.message.id, identity.serviceId, { acknowledgeDuplicateRisk: true }, crypto.randomUUID());
    expect(result).toMatchObject({ queued: 0, skipped: [{ deliveryId: delivery.id, reason: "provider_delivery_pending" }] });
    expect((await query("SELECT id FROM submissions WHERE message_id=$1", [accepted.message.id])).rowCount).toBe(1);
    expect((await query("SELECT id FROM submission_attempts WHERE submission_id=$1", [submission.id])).rowCount).toBe(1);
  });
  it.each(["deferred", "failed", "suppressed"] as const)("resolves an unknown attempt from trusted %s evidence and applies the appropriate retry policy", async type => {
    const input = createMessageSchema.parse({ category: "security", from: { email: "native@mail.atlas.test" }, to: [{ email: `unknown-${type}-${crypto.randomUUID()}@example.net` }], text: "Provider acceptance recovered from a trusted event" });
    const accepted = await acceptMessage({ identity, idempotencyKey: crypto.randomUUID(), input });
    created.push(accepted.message.id);
    const submission = (await query<{ id: string }>("SELECT id FROM submissions WHERE message_id=$1", [accepted.message.id])).rows[0];
    const prepared = await prepareSubmission(submission.id);
    if (!prepared || "reconcileAttemptId" in prepared) throw new Error("Expected a prepared submission");
    const externalId = crypto.randomUUID();
    await query("UPDATE submission_attempts SET external_message_id=$2 WHERE id=$1", [prepared.attemptId, externalId]);
    await markUnknown(prepared.attemptId, "Transport outcome was not recorded");
    expect((await getMessage(accepted.message.id, identity.serviceId))!.deliveries[0].lifecycle_status).toBe("unknown");
    await applyCanonicalEvent("pa_mock", null, { id: crypto.randomUUID(), externalMessageId: externalId, recipient: input.to[0].email, type, occurredAt: new Date(Date.now()+1000), metadata: { reason: "Recipient server temporarily unavailable" } });
    const attempt = (await query<{ status: string; outcome_determinate: boolean; reconcile_after: Date | null }>("SELECT status,outcome_determinate,reconcile_after FROM submission_attempts WHERE id=$1", [prepared.attemptId])).rows[0];
    expect(attempt).toEqual({ status: "accepted", outcome_determinate: true, reconcile_after: null });
    const delivery = (await getMessage(accepted.message.id, identity.serviceId))!.deliveries[0];
    expect(delivery.lifecycle_status).toBe(type === "deferred" ? "deferred" : "failed");
    if (type === "failed") {
      expect(await getDeliveryRetryEligibility(delivery.id)).toMatchObject({ allowed: true, requiresUnknownAcknowledgement: false });
      expect(await retryMessage(accepted.message.id, identity.serviceId, { deliveryIds: [delivery.id], acknowledgeDuplicateRisk: false }, crypto.randomUUID())).toMatchObject({ queued: 1 });
    } else {
      expect(await getDeliveryRetryEligibility(delivery.id)).toMatchObject({ allowed: false, reason: type === "deferred" ? "provider_delivery_pending" : "suppressed", requiresUnknownAcknowledgement: false });
      await expect(retryMessage(accepted.message.id, identity.serviceId, { deliveryIds: [delivery.id], acknowledgeDuplicateRisk: true }, crypto.randomUUID())).rejects.toBeInstanceOf(MessageValidationError);
    }
    expect((await query("SELECT id FROM submissions WHERE message_id=$1", [accepted.message.id])).rowCount).toBe(type === "failed" ? 2 : 1);
    expect((await query("SELECT id FROM submission_attempts WHERE submission_id=$1", [submission.id])).rowCount).toBe(1);
  });

});
