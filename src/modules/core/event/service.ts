import type { PoolClient } from "pg";
import type { CanonicalEvent, ProviderType, WebhookVerification } from "@/modules/providers/contracts";
import { objectStore } from "@/modules/config/object-store";
import { loadProviderAccount } from "@/modules/config/provider-account";
import { isTrustedSnsSubscribeUrl } from "@/modules/providers/ses/sns-security";
import { createId } from "@/server/ids";
import { query, transaction } from "@/server/database";
import { InboundTerminalError, processInboundEvent } from "@/modules/inbound/service";
import { PROVIDER_EVENT_RECEIVED } from "@/server/outbox-events";

const lifecycleTypes = ["queued", "submitting", "unknown", "accepted", "deferred", "delivered", "bounced", "failed", "canceled"];
const rank: Record<string, number> = { queued: 0, submitting: 1, unknown: 2, deferred: 3, accepted: 4, failed: 5, delivered: 6, bounced: 7, canceled: 8 };
export type DeliveryStateEvent = Omit<CanonicalEvent, "type"> & { type: CanonicalEvent["type"] | "queued" | "submitting" | "unknown" | "canceled" };

async function addCallbacks(client: PoolClient, delivery: {
  id: string; message_id: string; service_id: string; reference_id: string | null; recipient_email: string;
  product: string; category: string; lifecycle_status: string; engagement_status: string; compliance_status: string
}, eventId: string, event: DeliveryStateEvent, attemptId?: string) {
  const type = `email.${event.type}`;
  const endpoints = await client.query<{ id: string }>("SELECT id FROM callback_endpoints WHERE service_id=$1 AND status='active' AND $2=ANY(subscribed_events)", [delivery.service_id, type]);
  for (const endpoint of endpoints.rows) {
    const id = createId("cbx");
    const payload = {
      id: eventId, apiVersion: "2026-09-01", type, occurredAt: event.occurredAt.toISOString(),
      data: { messageId: delivery.message_id, deliveryId: delivery.id, referenceId: delivery.reference_id,
        recipient: delivery.recipient_email, product: delivery.product, category: delivery.category,
        lifecycle: lifecycleTypes.includes(event.type) ? event.type : delivery.lifecycle_status, ...(attemptId ? { attemptId } : {}), engagement: delivery.engagement_status, compliance: delivery.compliance_status }
    };
    const inserted = await client.query("INSERT INTO callback_deliveries(id,endpoint_id,delivery_event_id,event_type,payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id", [id, endpoint.id, eventId, type, payload]);
    if (inserted.rowCount) await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'callback',$2,'callback.requested',$3)", [createId("out"), id, { callbackDeliveryId: id }]);
  }
}

async function applySuppression(client: PoolClient, delivery: { recipient_email: string; product_id: string }, event: DeliveryStateEvent, providerEvent: boolean) {
  if (event.type === "complained" || (event.type === "suppressed" && providerEvent) || (event.type === "bounced" && event.bounce?.classification === "hard")) {
    await client.query("INSERT INTO suppressions(id,scope_type,email_normalized,reason,source) VALUES ($1,'global',$2,$3,'provider_event') ON CONFLICT DO NOTHING", [createId("sup"), delivery.recipient_email, event.type === "bounced" ? "hard_bounce" : event.type]);
  } else if (event.type === "unsubscribed") {
    const listId = typeof event.metadata.listId === "string" ? event.metadata.listId : null;
    await client.query("INSERT INTO suppressions(id,scope_type,product_id,list_id,email_normalized,reason,source) VALUES ($1,$2,$3,$4,$5,'unsubscribe','provider_event') ON CONFLICT DO NOTHING", [createId("sup"), listId ? "list" : "product", delivery.product_id, listId, delivery.recipient_email]);
  } else if (event.type === "bounced" && event.bounce?.classification === "soft") {
    const count = await client.query<{ count: string }>("SELECT count(*) FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id WHERE d.recipient_email=$1 AND de.event_type='bounced' AND de.canonical_payload#>>'{bounce,classification}'='soft' AND de.occurred_at>now()-interval '30 days'", [delivery.recipient_email]);
    if (Number(count.rows[0]?.count ?? 0) >= 3) await client.query("INSERT INTO suppressions(id,scope_type,email_normalized,reason,source,bounce_count,expires_at) VALUES ($1,'global',$2,'soft_bounce_threshold','provider_event',$3,now()+interval '7 days') ON CONFLICT DO NOTHING", [createId("sup"), delivery.recipient_email, Number(count.rows[0]?.count ?? 0)]);
  }
}

/** State, canonical fact, suppression and callback work commit together; callers may share their transaction. */
export async function applyDeliveryEvent(client: PoolClient, deliveryId: string, event: DeliveryStateEvent, sourceKey: string, options: { rawEventId?: string | null; attemptId?: string; forceLifecycle?: boolean; providerEvent?: boolean; projectLifecycle?: boolean } = {}) {
  const current = (await client.query<{ current_attempt_id: string | null; lifecycle_status: string }>("SELECT current_attempt_id,lifecycle_status FROM deliveries WHERE id=$1 FOR UPDATE", [deliveryId])).rows[0];
  if (!current) return false;
  const eventId = createId("dev");
  // Acceptance from the local result and its webhook is one business fact per attempt.
  const key = event.type === "accepted" && options.attemptId ? `attempt:${options.attemptId}:accepted` : sourceKey;
  const inserted = await client.query("INSERT INTO delivery_events(id,delivery_id,raw_provider_event_id,event_type,occurred_at,canonical_payload,source_key) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id", [eventId, deliveryId, options.rawEventId ?? null, event.type, event.occurredAt, { ...event, id: eventId, attemptId: options.attemptId, sourceId: event.id }, key]);
  if (!inserted.rowCount) return true;
  const currentAttempt = !options.attemptId || options.attemptId === current.current_attempt_id;
  if (lifecycleTypes.includes(event.type) && currentAttempt && options.projectLifecycle !== false) {
    const later = await client.query<{ event_type: string; occurred_at: Date }>(`SELECT event_type,occurred_at FROM delivery_events WHERE delivery_id=$1 AND id<>$2
      AND event_type=ANY($3::text[]) AND ($4::text IS NULL OR canonical_payload->>'attemptId'=$4)
      ORDER BY occurred_at DESC,CASE event_type WHEN 'canceled' THEN 8 WHEN 'bounced' THEN 7 WHEN 'delivered' THEN 6 WHEN 'failed' THEN 5 WHEN 'accepted' THEN 4 WHEN 'deferred' THEN 3 WHEN 'unknown' THEN 2 WHEN 'submitting' THEN 1 ELSE 0 END DESC,created_at DESC LIMIT 1`, [deliveryId, eventId, lifecycleTypes, options.attemptId ?? null]);
    const previous = later.rows[0];
    const terminal = ["delivered", "bounced", "failed", "canceled"].includes(current.lifecycle_status);
    const incomingTerminal = ["delivered", "bounced", "failed", "canceled"].includes(event.type);
    const chronological = !previous || previous.occurred_at < event.occurredAt || (previous.occurred_at.getTime() === event.occurredAt.getTime() && rank[event.type] > rank[previous.event_type]);
    const conclusiveAcceptance = event.type === "accepted" && ["queued", "submitting", "unknown"].includes(current.lifecycle_status);
    if (options.forceLifecycle || conclusiveAcceptance || (incomingTerminal && !terminal) || (chronological && (!terminal || incomingTerminal))) await client.query("UPDATE deliveries SET lifecycle_status=$2,accepted_at=CASE WHEN $2='accepted' THEN COALESCE(accepted_at,$3) ELSE accepted_at END,delivered_at=CASE WHEN $2='delivered' THEN COALESCE(delivered_at,$3) ELSE delivered_at END,updated_at=now() WHERE id=$1", [deliveryId, event.type, event.occurredAt]);
  } else if (event.type === "clicked" || event.type === "opened") {
    await client.query("UPDATE deliveries SET engagement_status=CASE WHEN engagement_status='clicked' THEN 'clicked' ELSE $2 END,updated_at=now() WHERE id=$1", [deliveryId, event.type]);
  } else if (["complained", "unsubscribed", "suppressed"].includes(event.type)) {
    await client.query("UPDATE deliveries SET compliance_status=CASE WHEN compliance_status='complained' OR $2='complained' THEN 'complained' WHEN compliance_status='unsubscribed' OR $2='unsubscribed' THEN 'unsubscribed' ELSE 'suppressed' END,updated_at=now() WHERE id=$1", [deliveryId, event.type]);
    if (event.type === "suppressed" && currentAttempt && ["queued", "deferred", "failed"].includes(current.lifecycle_status)) await client.query("UPDATE deliveries SET lifecycle_status='failed' WHERE id=$1", [deliveryId]);
  }
  const delivery = (await client.query<{
    id: string; message_id: string; service_id: string; product_id: string; reference_id: string | null; recipient_email: string;
    product: string; category: string; lifecycle_status: string; engagement_status: string; compliance_status: string
  }>("SELECT d.id,d.message_id,m.service_id,m.product_id,m.reference_id,d.recipient_email,p.name AS product,m.message_category AS category,d.lifecycle_status,d.engagement_status,d.compliance_status FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN products p ON p.id=m.product_id WHERE d.id=$1", [deliveryId])).rows[0];
  await applySuppression(client, delivery, event, options.providerEvent ?? false);
  await addCallbacks(client, delivery, eventId, event, options.attemptId);
  return true;
}

export async function applyCanonicalEvent(providerAccountId: string, rawEventId: string | null, event: CanonicalEvent) {
  if (!event.externalMessageId) return false;
  return transaction(async client => {
    const attempt = (await client.query<{ id: string; delivery_id: string }>("SELECT a.id,a.delivery_id FROM delivery_attempts a JOIN deliveries d ON d.id=a.delivery_id WHERE a.provider_account_id=$1 AND a.external_message_id=$2 AND ($3::text IS NULL OR d.recipient_email=lower($3))", [providerAccountId, event.externalMessageId, event.recipient ?? null])).rows[0];
    if (!attempt) return false;
    return applyDeliveryEvent(client, attempt.delivery_id, event, `provider:${providerAccountId}:${event.id}:${event.type}:${event.recipient ?? ""}`, { rawEventId, attemptId: attempt.id, providerEvent: true });
  });
}

export async function applySuppressedDelivery(deliveryId: string) {
  return transaction(client => applyDeliveryEvent(client, deliveryId, { id: `suppression:${deliveryId}`, type: "suppressed", occurredAt: new Date(), metadata: { source: "suppression_policy" } }, `suppression:${deliveryId}`));
}

/** Preserve binary multipart values without invoking a provider verifier again during replay. */
export function serializeVerification(verification: WebhookVerification) {
  return JSON.parse(JSON.stringify(verification, (_key, value) => {
    if (value instanceof Uint8Array) return { __envoyBytes: Buffer.from(value).toString("base64") };
    if (value && value.type === "Buffer" && Array.isArray(value.data)) return { __envoyBytes: Buffer.from(value.data).toString("base64") };
    return value;
  }));
}
function restoreVerification(value: unknown): WebhookVerification {
  return JSON.parse(JSON.stringify(value), (_key, item) => item && typeof item === "object" && typeof item.__envoyBytes === "string" ? new Uint8Array(Buffer.from(item.__envoyBytes, "base64")) : item);
}

export async function processRawProviderEvent(rawEventId: string) {
  const raw = (await query<{
    id: string; provider_account_id: string; webhook_endpoint_id: string; provider_type: ProviderType;
    processed_at: Date | null; verification: unknown; signature_valid: boolean; replay_valid: boolean; processing_attempt_count: number
  }>(`UPDATE raw_provider_events r SET processing_attempt_count=processing_attempt_count+1,next_attempt_at=now()+interval '2 minutes'
    FROM provider_accounts a WHERE r.id=$1 AND a.id=r.provider_account_id AND r.processed_at IS NULL
      AND r.next_attempt_at<=now() AND r.processing_attempt_count<20 AND r.content_purged_at IS NULL
    RETURNING r.id,r.provider_account_id,r.webhook_endpoint_id,a.type AS provider_type,r.processed_at,r.verification,r.signature_valid,r.replay_valid,r.processing_attempt_count`, [rawEventId])).rows[0];
  if (!raw) return;
  try {
    if (!raw.signature_valid || !raw.replay_valid || !raw.verification) throw new Error("Persisted webhook has no verified receipt");
    const account = await loadProviderAccount(raw.provider_account_id, { allowNonActive: true });
    const reference = raw.verification as { objectKey?: unknown };
    const receipt = typeof reference.objectKey === "string" ? JSON.parse(Buffer.from(await objectStore().get(reference.objectKey)).toString("utf8")) : raw.verification;
    const verified = restoreVerification(receipt);
    if (raw.provider_type === "ses") {
      const p = verified.parsed as Record<string, unknown>;
      if (p.Type === "SubscriptionConfirmation" && typeof p.SubscribeURL === "string" && typeof p.TopicArn === "string" && isTrustedSnsSubscribeUrl(p.SubscribeURL, p.TopicArn)) await fetch(p.SubscribeURL, { redirect: "error", signal: AbortSignal.timeout(5_000) });
    }
    const events = await account.module.webhook.normalize(verified, account.context);
    for (const item of events) {
      if (item.type === "inbound.received" && account.module.inbound) await processInboundEvent({ providerAccountId: raw.provider_account_id, webhookEndpointId: raw.webhook_endpoint_id, rawEventId: raw.id, verified, receive: value => account.module.inbound!.receive(value, account.context) });
      else if (!await applyCanonicalEvent(raw.provider_account_id, raw.id, item)) throw new Error("Provider event is waiting for its delivery attempt to be associated");
    }
    await query("UPDATE raw_provider_events SET processed_at=now(),processing_error=NULL WHERE id=$1", [raw.id]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown event error";
    if (error instanceof InboundTerminalError) {
      await query("UPDATE raw_provider_events SET processed_at=now(),processing_error=$2 WHERE id=$1", [raw.id, message]);
      return;
    }
    await transaction(async client => {
      await client.query("UPDATE raw_provider_events SET processing_error=$2,next_attempt_at=now()+interval '30 seconds' WHERE id=$1", [raw.id, message]);
      if (raw.processing_attempt_count < 20) await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'raw_provider_event',$2,$3,$4,now()+interval '30 seconds')", [createId("out"), raw.id, PROVIDER_EVENT_RECEIVED, { rawEventId: raw.id }]);
    });
  }
}
