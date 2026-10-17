import type { PoolClient } from "pg";
import type { CanonicalEvent, ProviderType, WebhookVerification } from "@/modules/providers/contracts";
import { safeDiagnostic } from "@/modules/providers/shared";
import { diagnostic, type Diagnostic } from "@/modules/core/diagnostics";
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

function eventDiagnostic(event: DeliveryStateEvent): Diagnostic | null {
  if (event.metadata.diagnostic && typeof event.metadata.diagnostic === "object") return event.metadata.diagnostic as Diagnostic;
  if (event.type === "bounced") return diagnostic(event.bounce?.classification === "hard" ? "MAILBOX_PERMANENTLY_REJECTED" : "MAILBOX_TEMPORARILY_REJECTED", safeDiagnostic(event.bounce?.message ?? "The recipient server rejected delivery."), "recipient_delivery", { acceptance: "accepted", providerCode: event.bounce?.code, smtpStatus: event.bounce?.code?.match(/\b[245]\.\d{1,3}\.\d{1,3}\b/)?.[0], occurredAt: event.occurredAt.toISOString() });
  if (event.type === "failed" || event.type === "deferred") return diagnostic(event.type === "failed" ? "DELIVERY_FAILED" : "DELIVERY_DEFERRED", safeDiagnostic(event.metadata.reason ?? event.bounce?.message ?? (event.type === "failed" ? "Delivery failed." : "The recipient server temporarily deferred delivery.")), "recipient_delivery", { acceptance: "accepted", retryable: event.type === "deferred", providerCode: typeof event.metadata.providerCode === "string" ? safeDiagnostic(event.metadata.providerCode) : event.bounce?.code, smtpStatus: typeof event.metadata.smtpStatus === "string" ? safeDiagnostic(event.metadata.smtpStatus) : undefined, retryDecision: { action: "none", reason: event.type === "deferred" ? "provider_managed_retry" : "not_retryable" }, occurredAt: event.occurredAt.toISOString() });
  if (event.type === "suppressed") return diagnostic("RECIPIENT_SUPPRESSED", "The recipient is blocked by suppression policy.", event.externalMessageId ? "recipient_delivery" : "policy", { acceptance: event.externalMessageId ? "accepted" : "not_accepted", occurredAt: event.occurredAt.toISOString() });
  return null;
}

async function enqueueCallbacks(client: PoolClient, serviceId: string, eventId: string, event: DeliveryStateEvent, data: Record<string, unknown>, scope: "recipient" | "submission") {
  const owned = await client.query("SELECT id FROM messages WHERE id=$1 AND service_id=$2 AND content_purged_at IS NULL",[data.messageId,serviceId]);
  if (!owned.rowCount) return;
  const type = `email.${event.type}`;
  const endpoints = (await client.query<{ id: string }>("SELECT id FROM callback_endpoints WHERE service_id=$1 AND status='active' AND $2=ANY(subscribed_events)", [serviceId, type])).rows;
  for (const endpoint of endpoints) {
    const id = createId("cbx");
    const payload = { id: eventId, apiVersion: "v1", type, scope, occurredAt: event.occurredAt.toISOString(), data };
    const inserted = await client.query(`INSERT INTO callback_deliveries(id,endpoint_id,delivery_event_id,submission_event_id,event_type,payload)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`, [id, endpoint.id, scope === "recipient" ? eventId : null, scope === "submission" ? eventId : null, type, payload]);
    if (inserted.rowCount) await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'callback',$2,'callback.requested',$3)", [createId("out"), id, { callbackDeliveryId: id }]);
  }
}

async function applySuppression(client: PoolClient, delivery: { recipient_email: string; product_id: string }, event: DeliveryStateEvent, providerEvent: boolean) {
  if (event.type === "complained" || (event.type === "suppressed" && providerEvent) || (event.type === "bounced" && event.bounce?.classification === "hard")) {
    await client.query("INSERT INTO suppressions(id,scope_type,email_normalized,reason,source) VALUES ($1,'global',lower($2),$3,'provider_event') ON CONFLICT DO NOTHING", [createId("sup"), delivery.recipient_email, event.type === "bounced" ? "hard_bounce" : event.type]);
  } else if (event.type === "unsubscribed") {
    const listId = typeof event.metadata.listId === "string" ? event.metadata.listId : null;
    await client.query("INSERT INTO suppressions(id,scope_type,product_id,list_id,email_normalized,reason,source) VALUES ($1,$2,$3,$4,lower($5),'unsubscribe','provider_event') ON CONFLICT DO NOTHING", [createId("sup"), listId ? "list" : "product", delivery.product_id, listId, delivery.recipient_email]);
  } else if (event.type === "bounced" && event.bounce?.classification === "soft") {
    const count = await client.query<{ count: string }>("SELECT count(*) FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id WHERE lower(d.recipient_email)=lower($1) AND de.event_type='bounced' AND de.canonical_payload#>>'{bounce,classification}'='soft' AND de.occurred_at>now()-interval '30 days'", [delivery.recipient_email]);
    if (Number(count.rows[0]?.count ?? 0) >= 3) await client.query("INSERT INTO suppressions(id,scope_type,email_normalized,reason,source,bounce_count,expires_at) VALUES ($1,'global',lower($2),'soft_bounce_threshold','provider_event',$3,now()+interval '7 days') ON CONFLICT DO NOTHING", [createId("sup"), delivery.recipient_email, Number(count.rows[0]?.count ?? 0)]);
  }
}

export async function applyDeliveryEvent(client: PoolClient, deliveryId: string, event: DeliveryStateEvent, sourceKey: string, options: { rawEventId?: string | null; attemptId?: string; forceLifecycle?: boolean; providerEvent?: boolean; projectLifecycle?: boolean } = {}) {
  const current = (await client.query<{ current_attempt_id: string | null; current_submission_id: string | null; lifecycle_status: string }>("SELECT current_attempt_id,current_submission_id,lifecycle_status FROM deliveries WHERE id=$1 FOR UPDATE", [deliveryId])).rows[0];
  if (!current) return false;
  const eventId = createId("dev");
  const key = event.type === "accepted" && options.attemptId ? `attempt:${options.attemptId}:${deliveryId}:accepted` : sourceKey;
  const error = eventDiagnostic(event);
  const payload = { ...event, id: eventId, attemptId: options.attemptId, sourceId: event.id, metadata: { ...event.metadata, ...(error ? { diagnostic: error } : {}) } };
  const inserted = await client.query("INSERT INTO delivery_events(id,delivery_id,raw_provider_event_id,event_type,occurred_at,canonical_payload,source_key) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id", [eventId, deliveryId, options.rawEventId ?? null, event.type, event.occurredAt, payload, key]);
  if (!inserted.rowCount) return true;
  const attemptSubmission = options.attemptId ? (await client.query<{ submission_id: string }>("SELECT submission_id FROM submission_attempts WHERE id=$1", [options.attemptId])).rows[0]?.submission_id : null;
  if (options.attemptId && current.current_attempt_id === null && current.lifecycle_status === "queued" && ["accepted", "delivered"].includes(event.type) && attemptSubmission) {
    // A conclusive late receipt can stop an authorized retry before its network call begins.
    // Once a new attempt has started, retain the old fact without rewriting the newer attempt.
    await client.query("UPDATE deliveries SET current_attempt_id=$2,current_submission_id=$3 WHERE id=$1", [deliveryId, options.attemptId, attemptSubmission]);
    current.current_attempt_id = options.attemptId;
    current.current_submission_id = attemptSubmission;
  }
  const currentAttempt = !options.attemptId || (options.attemptId === current.current_attempt_id && attemptSubmission === current.current_submission_id);
  let projects = false;
  if (lifecycleTypes.includes(event.type) && currentAttempt && options.projectLifecycle !== false) {
    const previous = (await client.query<{ event_type: string; occurred_at: Date }>(`SELECT event_type,occurred_at FROM delivery_events WHERE delivery_id=$1 AND id<>$2
      AND event_type=ANY($3::text[]) AND ($4::text IS NULL OR canonical_payload->>'attemptId'=$4)
      ORDER BY occurred_at DESC,CASE event_type WHEN 'canceled' THEN 8 WHEN 'bounced' THEN 7 WHEN 'delivered' THEN 6 WHEN 'failed' THEN 5 WHEN 'accepted' THEN 4 WHEN 'deferred' THEN 3 WHEN 'unknown' THEN 2 WHEN 'submitting' THEN 1 ELSE 0 END DESC,created_at DESC LIMIT 1`, [deliveryId, eventId, lifecycleTypes, options.attemptId ?? null])).rows[0];
    const terminal = ["delivered", "bounced", "failed", "canceled"].includes(current.lifecycle_status);
    const incomingTerminal = ["delivered", "bounced", "failed", "canceled"].includes(event.type);
    const chronological = !previous || previous.occurred_at < event.occurredAt || (previous.occurred_at.getTime() === event.occurredAt.getTime() && rank[event.type] > rank[previous.event_type]);
    const conclusiveAcceptance = event.type === "accepted" && ["queued", "submitting", "unknown"].includes(current.lifecycle_status);
    projects = Boolean(options.forceLifecycle || conclusiveAcceptance || (incomingTerminal && !terminal) || (chronological && (!terminal || incomingTerminal)));
    if (projects) await client.query("UPDATE deliveries SET lifecycle_status=$2,accepted_at=CASE WHEN $2='accepted' THEN COALESCE(accepted_at,$3) ELSE accepted_at END,delivered_at=CASE WHEN $2='delivered' THEN COALESCE(delivered_at,$3) ELSE delivered_at END,updated_at=now() WHERE id=$1", [deliveryId, event.type, event.occurredAt]);
  } else if ((event.type === "clicked" || event.type === "opened") && currentAttempt) {
    await client.query("UPDATE deliveries SET engagement_status=CASE WHEN engagement_status='clicked' THEN 'clicked' ELSE $2 END,updated_at=now() WHERE id=$1", [deliveryId, event.type]);
  } else if (["complained", "unsubscribed", "suppressed"].includes(event.type)) {
    await client.query("UPDATE deliveries SET compliance_status=CASE WHEN compliance_status='complained' OR $2='complained' THEN 'complained' WHEN compliance_status='unsubscribed' OR $2='unsubscribed' THEN 'unsubscribed' ELSE 'suppressed' END,updated_at=now() WHERE id=$1", [deliveryId, event.type]);
    if (event.type === "suppressed" && currentAttempt && ["queued", "deferred", "failed", ...(options.providerEvent ? ["submitting", "accepted", "unknown"] : [])].includes(current.lifecycle_status)) { await client.query("UPDATE deliveries SET lifecycle_status='failed' WHERE id=$1", [deliveryId]); projects = true; }
  }
  if (projects && error) await client.query("UPDATE deliveries SET last_error=$2 WHERE id=$1", [deliveryId, error]);
  else if (projects && ["queued", "delivered", "accepted"].includes(event.type)) await client.query("UPDATE deliveries SET last_error=NULL WHERE id=$1", [deliveryId]);
  const delivery = (await client.query<{ id: string; message_id: string; service_id: string; product_id: string; reference_id: string | null; request_id: string | null; recipient_email: string; recipient_role: string; product: string; category: string; lifecycle_status: string; engagement_status: string; compliance_status: string }>("SELECT d.id,d.message_id,m.service_id,m.product_id,m.reference_id,m.request_id,d.recipient_email,d.recipient_role,p.name AS product,m.message_category AS category,d.lifecycle_status,d.engagement_status,d.compliance_status FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN products p ON p.id=m.product_id WHERE d.id=$1", [deliveryId])).rows[0];
  await applySuppression(client, delivery, event, options.providerEvent ?? false);
  await enqueueCallbacks(client, delivery.service_id, eventId, event, {
    messageId: delivery.message_id, deliveryId: delivery.id, requestId: delivery.request_id, referenceId: delivery.reference_id,
    recipient: delivery.recipient_email, recipientRole: delivery.recipient_role, product: delivery.product, category: delivery.category,
    lifecycle: lifecycleTypes.includes(event.type) ? event.type : delivery.lifecycle_status, currentLifecycle: delivery.lifecycle_status, ...(options.attemptId ? { attemptId: options.attemptId } : {}),
    engagement: delivery.engagement_status, compliance: delivery.compliance_status, ...(error ? { diagnostic: error } : {}),
    ...(event.bounce ? { bounce: { ...event.bounce, message: event.bounce.message ? safeDiagnostic(event.bounce.message) : undefined } } : {}),
  }, "recipient");
  return true;
}

export async function applySubmissionEvent(client: PoolClient, submissionId: string, event: DeliveryStateEvent, sourceKey: string, attemptId?: string, rawEventId?: string | null) {
  const id = createId("sev");
  const error = eventDiagnostic(event);
  const payload = { ...event, id, attemptId, sourceId: event.id, metadata: { ...event.metadata, ...(error ? { diagnostic: error } : {}) } };
  const key = event.type === "accepted" && attemptId ? `attempt:${attemptId}:accepted` : sourceKey;
  const inserted = await client.query("INSERT INTO submission_events(id,submission_id,attempt_id,event_type,source_key,occurred_at,canonical_payload,raw_provider_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id", [id, submissionId, attemptId ?? null, event.type, key, event.occurredAt, payload, rawEventId ?? null]);
  if (!inserted.rowCount) return true;
  const owner = (await client.query<{ id: string; service_id: string; request_id: string | null; reference_id: string | null }>("SELECT m.id,m.service_id,m.request_id,m.reference_id FROM messages m JOIN submissions s ON s.message_id=m.id WHERE s.id=$1", [submissionId])).rows[0];
  await enqueueCallbacks(client, owner.service_id, id, event, { messageId: owner.id, submissionId, requestId: owner.request_id, referenceId: owner.reference_id, ...(attemptId ? { attemptId } : {}), ...(error ? { diagnostic: error } : {}) }, "submission");
  return true;
}

export async function applyCanonicalEvent(providerAccountId: string, rawEventId: string | null, event: CanonicalEvent) {
  if (!event.externalMessageId) return false;
  return transaction(async client => {
    const found = (await client.query<{ id: string; submission_id: string; message_id: string }>("SELECT a.id,a.submission_id,s.message_id FROM submission_attempts a JOIN submissions s ON s.id=a.submission_id WHERE a.provider_account_id=$1 AND a.external_message_id=$2", [providerAccountId, event.externalMessageId])).rows[0];
    if (!found) return false;
    await client.query("SELECT id FROM messages WHERE id=$1 FOR UPDATE", [found.message_id]);
    await client.query("SELECT id FROM submissions WHERE id=$1 FOR UPDATE", [found.submission_id]);
    await client.query("SELECT id FROM submission_attempts WHERE id=$1 FOR UPDATE", [found.id]);
    const rows = (await client.query<{ id: string }>(`SELECT d.id FROM submission_deliveries sd JOIN deliveries d ON d.id=sd.delivery_id
      WHERE sd.submission_id=$1 AND ($2::text IS NULL OR lower(d.recipient_email)=lower($2)) ORDER BY d.id`, [found.submission_id, event.recipient ?? null])).rows;
    if (event.recipient && !rows.length) return false;
    // Trusted post-submission facts prove acceptance even when the sender lost
    // its HTTP response. Resolve transport uncertainty as accepted for the immutable request group;
    // message-scoped facts still never invent recipient delivery or engagement.
    if (["accepted", "deferred", "delivered", "bounced", "failed", "opened", "clicked", "complained", "unsubscribed", "suppressed"].includes(event.type)) {
      const resolved = await client.query<{started_at:Date}>(`UPDATE submission_attempts SET status='accepted',outcome_determinate=true,
        diagnostic=NULL,error_category=NULL,error_code=NULL,error_message=NULL,reconcile_after=NULL,finished_at=COALESCE(finished_at,now())
        WHERE id=$1 AND status IN ('submitting','unknown','reconciling') RETURNING started_at`, [found.id]);
      if (resolved.rowCount) {
        await client.query("UPDATE submissions SET status='accepted',updated_at=now() WHERE id=$1 AND current_attempt_id=$2", [found.submission_id, found.id]);
        const acceptance: DeliveryStateEvent = { id: `accepted:${event.id}`, type: "accepted", occurredAt: resolved.rows[0].started_at, metadata: { source: "verified_provider_fact" } };
        await applySubmissionEvent(client, found.submission_id, acceptance, `attempt:${found.id}:accepted`, found.id, rawEventId);
        const group = (await client.query<{id:string}>("SELECT delivery_id AS id FROM submission_deliveries WHERE submission_id=$1 ORDER BY delivery_id", [found.submission_id])).rows;
        for (const recipient of group) await applyDeliveryEvent(client, recipient.id, acceptance, `attempt:${found.id}:${recipient.id}:accepted`, { rawEventId, attemptId: found.id, providerEvent: true });
      }
    }
    if (!event.recipient && event.type !== "accepted") {
      // Message-scoped provider facts are retained without inventing per-recipient results.
      return applySubmissionEvent(client, found.submission_id, event, `provider:${providerAccountId}:${event.id}:${event.type}`, found.id, rawEventId);
    }
    for (const row of rows) await applyDeliveryEvent(client, row.id, event, `provider:${providerAccountId}:${event.id}:${event.type}:${row.id}`, { rawEventId, attemptId: found.id, providerEvent: true });
    return true;
  });
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
      AND r.next_attempt_at<=now() AND r.processing_attempt_count<20 AND r.content_purged_at IS NULL AND r.terminated_at IS NULL
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
