import { outboundDomainAccess } from "@/modules/core/resources/authorization";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { createMessageSchema, type AcceptedMessage, type CreateMessageInput, deliveryStatuses } from "@/lib/contracts";
import { applyDeliveryEvent } from "@/modules/core/event/service";
import { diagnostic } from "@/modules/core/diagnostics";
import { resolveOutboundAttachments } from "@/modules/files/service";
import { providerRegistry } from "@/modules/providers/registry";
import type { ProviderType } from "@/modules/providers/contracts";
import type { ServiceIdentity } from "@/server/auth";
import { query, transaction } from "@/server/database";
import { createId } from "@/server/ids";
import { authorizedDomain, capabilityIssue, subsetEnvelope, type MessageContent } from "./native";

export class MessageValidationError extends Error {
  constructor(public readonly issues: string[], public readonly code = "INVALID_MESSAGE") { super(issues.join(" ")); }
}
export class IdempotencyConflictError extends Error {
  constructor() { super("The idempotency key was already used with different content."); }
}
export class DuplicateRiskError extends Error {}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function hashPayload(input: unknown) { return createHash("sha256").update(JSON.stringify(stable(input))).digest("hex"); }

export function encodeCursor(row: { accepted_at: Date; id: string; cursor_at?: string }) {
  return Buffer.from(JSON.stringify({ at: row.cursor_at ?? row.accepted_at.toISOString(), id: row.id })).toString("base64url");
}
export function decodeCursor(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { at?: string; id?: string };
    if (typeof parsed.id !== "string" || !parsed.id || typeof parsed.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/.test(parsed.at) || Number.isNaN(Date.parse(parsed.at))) return null;
    return { at: parsed.at, id: parsed.id };
  } catch { return null; }
}

export async function isSuppressed(client: PoolClient, productId: string, email: string, listId?: string) {
  return Boolean((await client.query(`SELECT 1 FROM suppressions WHERE active=true AND email_normalized=lower($1)
    AND (expires_at IS NULL OR expires_at>now()) AND (scope_type='global' OR (scope_type='product' AND product_id=$2)
    OR (scope_type='list' AND product_id=$2 AND list_id=$3)) LIMIT 1`, [email, productId, listId ?? null])).rowCount);
}

export async function assertRoutable(client: PoolClient, message: MessageContent, recipients: { email: string; name?: string }[]) {
  const rows = (await client.query<{ type: ProviderType }>(`SELECT DISTINCT pa.type FROM routing_policies rp
    JOIN routing_targets rt ON rt.policy_id=rp.id JOIN provider_accounts pa ON pa.id=rt.provider_account_id
    JOIN provider_identities pi ON pi.id=rt.provider_identity_id AND pi.provider_account_id=pa.id
    WHERE rp.sending_domain_id=$1 AND pi.sending_domain_id=$1 AND pi.status='verified' AND rp.status='active'
      AND (rp.product_id IS NULL OR rp.product_id=$2) AND (rp.service_id IS NULL OR rp.service_id=$3)
      AND (rp.message_category IS NULL OR rp.message_category=$4)`,
  [message.sending_domain_id, message.product_id, message.service_id, message.message_category])).rows;
  if (!rows.length) throw new MessageValidationError(["No verified routing target is configured for this sender and message category."], "NO_ELIGIBLE_ROUTE");
  const envelope = subsetEnvelope(message, recipients);
  const issues = rows.map(row => capabilityIssue(message, providerRegistry(row.type).descriptor.capabilities, envelope));
  if (issues.every(Boolean)) throw new MessageValidationError([...new Set(issues.filter((value): value is string => Boolean(value)))], "UNSUPPORTED_MESSAGE_CAPABILITY");
}

export async function createSubmission(client: PoolClient, messageId: string, deliveryIds: string[]) {
  if (!deliveryIds.length) return null;
  const id = createId("sub");
  await client.query("INSERT INTO submissions(id,message_id) VALUES ($1,$2)", [id, messageId]);
  await client.query("INSERT INTO submission_deliveries(submission_id,delivery_id) SELECT $1,unnest($2::text[])", [id, deliveryIds]);
  await client.query("UPDATE deliveries SET current_submission_id=$1,current_attempt_id=NULL WHERE id=ANY($2::text[])", [id, deliveryIds]);
  await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'submission',$2,'submission.requested',$3)", [createId("out"), id, { submissionId: id }]);
  return id;
}

export async function acceptMessage(args: { identity: ServiceIdentity; idempotencyKey: string; input: CreateMessageInput; requestId?: string }) {
  const validated = createMessageSchema.safeParse(args.input);
  if (!validated.success) throw new MessageValidationError(validated.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`));
  const input = validated.data;
  if (!args.idempotencyKey.trim() || args.idempotencyKey.length > 256) throw new MessageValidationError(["A valid idempotency key is required."]);
  const payloadHash = hashPayload(input);
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([args.identity.serviceId, args.idempotencyKey])]);
    const existing = (await client.query<{ id: string; payload_hash: string; accepted_at: Date; product: string; message_category: string; recipient_count: number; reference_id: string | null }>(
      "SELECT id,payload_hash,accepted_at,sender_snapshot->>'product' AS product,message_category,recipient_count,reference_id FROM messages WHERE service_id=$1 AND idempotency_key=$2 FOR UPDATE", [args.identity.serviceId, args.idempotencyKey])).rows[0];
    const receipt = (row: { id: string; accepted_at: Date; product: string; message_category: string; recipient_count: number; reference_id: string | null }): AcceptedMessage => ({
      id: row.id, processingState: "queued", outcome: "pending", product: row.product, category: row.message_category,
      recipientCount: row.recipient_count, acceptedAt: row.accepted_at.toISOString(), ...(row.reference_id ? { referenceId: row.reference_id } : {}),
    });
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new IdempotencyConflictError();
      return { duplicate: true, message: receipt(existing) };
    }
    const domainId = await authorizedDomain(client, args.identity, input.from.email);
    if (!domainId) throw new MessageValidationError(["This service is not authorized to send from the supplied address."], "SENDER_NOT_AUTHORIZED");
    const attachments = await resolveOutboundAttachments(args.identity.serviceId, input.attachments, client, domainId);
    const id = createId("msg");
    const content: MessageContent = {
      id, product_id: args.identity.productId, service_id: args.identity.serviceId, sending_domain_id: domainId,
      sender_snapshot: { product: args.identity.product, fromName: input.from.name, fromEmail: input.from.email, domainId },
      to_recipients: input.to, cc_recipients: input.cc, bcc_recipients: input.bcc, reply_to: input.replyTo,
      subject: input.subject, html_body: input.html ?? null, text_body: input.text ?? null,
      headers: input.headers, in_reply_to: input.inReplyTo ?? null, references_ids: input.references,
      attachment_snapshot: attachments, provider_tags: input.tags ?? {}, message_category: input.category,
      content_purged_at: null, metadata: input.metadata ?? {},
    };
    const recipients = [];
    for (const role of ["to", "cc", "bcc"] as const) for (const address of input[role]) recipients.push({ ...address, role, blocked: await isSuppressed(client, args.identity.productId, address.email, input.metadata?.listId) });
    const allowed = recipients.filter(item => !item.blocked);
    if (allowed.length) await assertRoutable(client, content, allowed);
    const accepted = (await client.query<{ accepted_at: Date }>(`INSERT INTO messages(id,product_id,service_id,sending_domain_id,request_id,idempotency_key,payload_hash,
      reference_id,metadata,recipient_count,subject,html_body,text_body,message_category,reply_to,provider_tags,sender_snapshot,
      to_recipients,cc_recipients,bcc_recipients,headers,in_reply_to,references_ids,attachment_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING accepted_at`,
    [id, content.product_id, content.service_id, domainId, args.requestId ?? null, args.idempotencyKey, payloadHash, input.referenceId ?? null,
      content.metadata, recipients.length, input.subject, content.html_body, content.text_body, input.category, JSON.stringify(input.replyTo), content.provider_tags,
      content.sender_snapshot, JSON.stringify(input.to), JSON.stringify(input.cc), JSON.stringify(input.bcc), input.headers, input.inReplyTo ?? null, input.references, JSON.stringify(attachments)])).rows[0];
    const deliveryIds: string[] = [];
    for (const recipient of recipients) {
      const deliveryId = createId("dlv");
      await client.query("INSERT INTO deliveries(id,message_id,recipient_email,recipient_name,recipient_role) VALUES ($1,$2,$3,$4,$5)", [deliveryId, id, recipient.email, recipient.name ?? null, recipient.role]);
      if (!recipient.blocked) deliveryIds.push(deliveryId);
      await applyDeliveryEvent(client, deliveryId, {
        id: deliveryId, type: recipient.blocked ? "suppressed" : "queued", occurredAt: accepted.accepted_at,
        metadata: recipient.blocked ? { diagnostic: diagnostic("RECIPIENT_SUPPRESSED", "The recipient is blocked by the current suppression policy.", "policy") } : {},
      }, `message:${id}:${deliveryId}:accepted`);
    }
    await createSubmission(client, id, deliveryIds);
    return { duplicate: false, message: receipt({ id, accepted_at: accepted.accepted_at, product: args.identity.product, message_category: input.category, recipient_count: recipients.length, reference_id: input.referenceId ?? null }) };
  });
}

const stats = `JOIN LATERAL (SELECT count(*)::int AS total,
  count(*) FILTER(WHERE lifecycle_status='queued')::int AS queued,
  count(*) FILTER(WHERE lifecycle_status=ANY(ARRAY['queued','submitting','accepted','deferred']))::int AS active,
  count(*) FILTER(WHERE lifecycle_status='unknown')::int AS unknown,
  count(*) FILTER(WHERE lifecycle_status='delivered')::int AS delivered,
  count(*) FILTER(WHERE lifecycle_status='canceled')::int AS canceled,
  jsonb_build_object(${deliveryStatuses.map(status => `'${status}',count(*) FILTER(WHERE lifecycle_status='${status}')`).join(",")},'suppressed',count(*) FILTER(WHERE compliance_status='suppressed')) AS counts
  FROM deliveries WHERE message_id=m.id) ds ON true`;
const projection = `SELECT m.*,m.sender_snapshot->>'product' AS product,m.message_category AS category,ds.counts,
  CASE WHEN ds.queued=ds.total THEN 'queued' WHEN ds.active>0 OR ds.unknown>0 THEN 'processing' ELSE 'finished' END AS processing_state,
  CASE WHEN ds.unknown>0 THEN 'unknown' WHEN ds.active>0 THEN 'pending' WHEN ds.delivered=ds.total THEN 'succeeded'
    WHEN ds.canceled=ds.total THEN 'canceled' WHEN ds.delivered>0 THEN 'partially_failed' ELSE 'failed' END AS outcome,
  to_char(m.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
  FROM messages m ${stats}`;
export type MessageRow = MessageContent & {
  request_id: string | null; accepted_at: Date; recipient_count: number; reference_id: string | null;
  product: string; category: string; counts: Record<string, number>; processing_state: "queued" | "processing" | "finished";
  outcome: "pending" | "succeeded" | "partially_failed" | "failed" | "canceled" | "unknown"; cursor_at: string;
};
export async function listMessages(serviceId: string, options: { limit: number; cursor?: { at: Date | string; id: string } | null; processingState?: string | null; outcome?: string | null; referenceId?: string | null }) {
  const rows = (await query<MessageRow>(`SELECT * FROM (${projection} WHERE m.service_id=$1 AND ${outboundDomainAccess('m')}
    AND ($2::text IS NULL OR m.reference_id=$2) AND ($3::timestamptz IS NULL OR (m.accepted_at,m.id)<($3,$4))) result
    WHERE ($5::text IS NULL OR processing_state=$5) AND ($6::text IS NULL OR outcome=$6)
    ORDER BY accepted_at DESC,id DESC LIMIT $7`, [serviceId, options.referenceId ?? null, options.cursor?.at ?? null, options.cursor?.id ?? null, options.processingState ?? null, options.outcome ?? null, options.limit + 1])).rows;
  const more = rows.length > options.limit;
  const data = (more ? rows.slice(0, options.limit) : rows).map(row => ({
    id: row.id, processingState: row.processing_state, outcome: row.outcome, counts: row.counts,
    product: row.product, category: row.category, from: { email: row.sender_snapshot.fromEmail, name: row.sender_snapshot.fromName },
    subject: row.subject, referenceId: row.reference_id, recipientCount: row.recipient_count, acceptedAt: row.accepted_at.toISOString(),
  }));
  return { data, nextCursor: more ? encodeCursor(rows[options.limit - 1]) : null };
}
export async function getMessage(id: string, serviceId: string) {
  const message = (await query<MessageRow>(`${projection} WHERE m.id=$1 AND m.service_id=$2 AND ${outboundDomainAccess('m')}`, [id, serviceId])).rows[0];
  if (!message) return null;
  const deliveries = (await query<{ id: string; recipient_email: string; recipient_name: string | null; recipient_role: "to" | "cc" | "bcc"; lifecycle_status: string; engagement_status: string; compliance_status: string; last_error: unknown; updated_at: Date }>("SELECT id,recipient_email,recipient_name,recipient_role,lifecycle_status,engagement_status,compliance_status,last_error,updated_at FROM deliveries WHERE message_id=$1 ORDER BY queued_at,id", [id])).rows;
  return { ...message, deliveries };
}

export async function cancelMessage(id: string, serviceId: string) {
  return transaction(async client => {
    if (!(await client.query(`SELECT id FROM messages m WHERE id=$1 AND service_id=$2 AND ${outboundDomainAccess('m')} FOR UPDATE`, [id, serviceId])).rowCount) return null;
    await client.query("SELECT id FROM submissions WHERE message_id=$1 ORDER BY id FOR UPDATE", [id]);
    const rows = (await client.query<{ id: string }>(`SELECT d.id FROM deliveries d LEFT JOIN submission_attempts a ON a.id=d.current_attempt_id
      WHERE d.message_id=$1 AND d.lifecycle_status IN ('queued','deferred')
      AND (a.id IS NULL OR (a.outcome_determinate AND a.status='failed')) ORDER BY d.id FOR UPDATE OF d`, [id])).rows;
    for (const row of rows) await applyDeliveryEvent(client, row.id, { id: createId("cancel"), type: "canceled", occurredAt: new Date(), metadata: { source: "service_api" } }, `cancel:${createId("evt")}`, { forceLifecycle: true });
    await client.query(`UPDATE submissions s SET status='canceled',updated_at=now() WHERE message_id=$1 AND status IN ('queued','deferred')
      AND NOT EXISTS(SELECT 1 FROM submission_deliveries sd JOIN deliveries d ON d.id=sd.delivery_id WHERE sd.submission_id=s.id AND d.lifecycle_status IN ('queued','deferred','submitting'))`, [id]);
    return { messageId: id, canceled: rows.length };
  });
}

export type RetryOptions = { acknowledgeUnknown: boolean; actor: string };
async function retryState(client: PoolClient, deliveryId: string) {
  return (await client.query<{ id: string; message_id: string; service_id: string; lifecycle_status: string; compliance_status: string; current_attempt_id: string | null; uncertain: boolean; live: boolean; provider_pending: boolean; content_expired: boolean; enabled: boolean; blocked: boolean }>(`SELECT d.id,d.message_id,m.service_id,d.lifecycle_status,d.compliance_status,d.current_attempt_id,
    COALESCE(NOT a.outcome_determinate,false) AS uncertain,(a.status='submitting') IS TRUE AS live,(a.status IN ('accepted','reconciled') AND d.lifecycle_status='deferred') IS TRUE AS provider_pending,m.content_purged_at IS NOT NULL AS content_expired,
    ${outboundDomainAccess('m')} AS enabled,
    EXISTS(SELECT 1 FROM suppressions su WHERE su.active AND su.email_normalized=lower(d.recipient_email) AND (su.expires_at IS NULL OR su.expires_at>now())
      AND (su.scope_type='global' OR (su.product_id=m.product_id AND (su.scope_type='product' OR su.list_id=m.metadata->>'listId')))) AS blocked
    FROM deliveries d JOIN messages m ON m.id=d.message_id LEFT JOIN submission_attempts a ON a.id=d.current_attempt_id WHERE d.id=$1 FOR UPDATE OF d`, [deliveryId])).rows[0];
}
function eligibility(row: Awaited<ReturnType<typeof retryState>>) {
  if (!row) return { allowed: false, reason: "not_found", requiresUnknownAcknowledgement: false };
  const reason = row.live ? "submission_in_progress" : row.provider_pending ? "provider_delivery_pending" : row.content_expired ? "content_expired" : row.blocked || row.compliance_status !== "clean" ? "suppressed" : !row.enabled ? "sender_not_authorized" : !["failed", "deferred", "unknown", "bounced"].includes(row.lifecycle_status) ? "status_not_retryable" : null;
  return { allowed: !reason, reason, requiresUnknownAcknowledgement: row.uncertain || row.lifecycle_status === "unknown" };
}
export async function getDeliveryRetryEligibility(deliveryId: string) {
  return transaction(async client => {
    await client.query("SELECT m.id FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE d.id=$1 FOR UPDATE OF m", [deliveryId]);
    return eligibility(await retryState(client, deliveryId));
  });
}
export async function retryMessage(id: string, serviceId: string, input: { deliveryIds?: string[]; acknowledgeDuplicateRisk: boolean }, idempotencyKey: string, actor = `service:${serviceId}`) {
  if (!idempotencyKey?.trim() || idempotencyKey.length > 256) throw new MessageValidationError(["Idempotency-Key is required for retry."]);
  const payloadHash = hashPayload(input);
  return transaction(async client => {
    const message = (await client.query<MessageContent>(`SELECT * FROM messages m WHERE id=$1 AND service_id=$2 AND ${outboundDomainAccess('m')} FOR UPDATE`, [id, serviceId])).rows[0];
    if (!message) return null;
    const prior = (await client.query<{ payload_hash: string; result: { messageId: string; submissionId: string | null; queued: number; skipped: { deliveryId: string; reason: string | null }[] } }>("SELECT payload_hash,result FROM message_retries WHERE message_id=$1 AND idempotency_key=$2", [id, idempotencyKey])).rows[0];
    if (prior) { if (prior.payload_hash !== payloadHash) throw new IdempotencyConflictError(); return prior.result; }
    await client.query("SELECT id FROM submissions WHERE message_id=$1 ORDER BY id FOR UPDATE", [id]);
    const all = (await client.query<{ id: string; recipient_email: string; recipient_name: string | null }>("SELECT id,recipient_email,recipient_name FROM deliveries WHERE message_id=$1 ORDER BY id", [id])).rows;
    const wanted = input.deliveryIds ? new Set(input.deliveryIds) : null;
    if (wanted && (!wanted.size || wanted.size !== input.deliveryIds!.length || [...wanted].some(target => !all.some(row => row.id === target)))) throw new MessageValidationError(["deliveryIds must be unique recipients belonging to this message."], "INVALID_RETRY_TARGET");
    const eligible = [];
    const skipped = [];
    for (const row of all) {
      if (wanted && !wanted.has(row.id)) continue;
      const state = await retryState(client, row.id);
      const check = eligibility(state);
      if (!check.allowed) { skipped.push({ deliveryId: row.id, reason: check.reason }); continue; }
      if (check.requiresUnknownAcknowledgement && !input.acknowledgeDuplicateRisk) throw new DuplicateRiskError("Unknown outcomes require duplicate-risk acknowledgement.");
      eligible.push({ ...row, state: state! });
    }
    if (wanted && skipped.length) throw new MessageValidationError(skipped.map(row => `${row.deliveryId}: ${row.reason}`), "RETRY_NOT_ALLOWED");
    if (eligible.length) await assertRoutable(client, message, eligible.map(row => ({ email: row.recipient_email, name: row.recipient_name ?? undefined })));
    for (const row of eligible) {
      if (row.state.current_attempt_id) await client.query("UPDATE submission_attempts SET retry_authorized_at=now(),retry_authorized_by=$2 WHERE id=$1", [row.state.current_attempt_id, actor]);
      await applyDeliveryEvent(client, row.id, { id: createId("retry"), type: "queued", occurredAt: new Date(), metadata: { source: "authorized_retry", actor } }, `retry:${createId("evt")}`, { forceLifecycle: true });
    }
    const submissionId = await createSubmission(client, id, eligible.map(row => row.id));
    const result = { messageId: id, submissionId, queued: eligible.length, skipped };
    await client.query("INSERT INTO message_retries(message_id,idempotency_key,payload_hash,result) VALUES ($1,$2,$3,$4)", [id, idempotencyKey, payloadHash, result]);
    return result;
  });
}
export async function retryDelivery(deliveryId: string, options: RetryOptions) {
  const message = (await query<{ id: string; service_id: string }>("SELECT m.id,m.service_id FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE d.id=$1", [deliveryId])).rows[0];
  if (!message) return { deliveryId, queued: false, reason: "not_found" };
  const result = await retryMessage(message.id, message.service_id, { deliveryIds: [deliveryId], acknowledgeDuplicateRisk: options.acknowledgeUnknown }, createId("retry"), options.actor);
  return { deliveryId, queued: Boolean(result?.queued), reason: result?.skipped[0]?.reason ?? null };
}
