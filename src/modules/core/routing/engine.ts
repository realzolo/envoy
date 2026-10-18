import { sendingContent, assertSendDeadline, DEADLINE_CODE, DEADLINE_MESSAGE } from "@/modules/core/message/policy";
import { secretDigest } from "@/modules/config/envelope";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { authorizedDomain, canonicalMessage, capabilityIssue, subsetEnvelope, type MessageContent, type StoredAttachment } from "@/modules/core/message/native";
import { createSubmission, isSuppressed } from "@/modules/core/message/service";
import { diagnostic, type Diagnostic } from "@/modules/core/diagnostics";
import { safeDiagnostic } from "@/modules/providers/shared";
import type { DeliveryStateEvent } from "@/modules/core/event/service";
import type { CanonicalMessage, ProviderType } from "@/modules/providers/contracts";
import { providerRegistry } from "@/modules/providers/registry";
import { query, transaction } from "@/server/database";
import { createId } from "@/server/ids";
import { reserveRateLimits } from "@/server/runtime-store";
import { applyDeliveryEvent, applySubmissionEvent } from "@/modules/core/event/service";

type Candidate = {
  target_id: string;
  policy_id: string;
  policy_name: string;
  policy_priority: number;
  provider_account_id: string;
  provider_identity_id: string;
  provider_type: ProviderType;
  provider_name: string;
  priority: number;
  weight: number;
  rate_limit_per_minute: number;
  domain: string;
  quota: Record<string, unknown>;
  monthly_usage: string;
  daily_usage: string;
  status: string; circuit_open_until: Date | null; account_status: string; health: Record<string, unknown>; identity_status: string; domain_status: string
};
export type DeliverySubmission = {
  attemptId: string; attemptNumber: number; submissionId: string; messageId: string;
  providerAccountId: string; providerIdentityId: string; providerType: ProviderType; providerName: string;
  providerIdempotencyKey: string | null; requestFingerprint: string; routingSnapshot: Record<string, unknown>;
  message: CanonicalMessage; attachments: StoredAttachment[]; sendBefore: Date | null; sensitive: boolean;
};

export function chooseWeighted<T extends {
  priority: number;
  weight: number
}>(deliveryId: string, attempt: number, candidates: T[]) {
  if (!candidates.length) return undefined;
  const min = Math.min(...candidates.map(c => c.priority));
  const eligible = candidates.filter(c => c.priority === min);
  const total = eligible.reduce((sum, c) => sum + c.weight, 0);
  const hash = createHash("sha256").update(`${deliveryId}:${attempt}`).digest().readUInt32BE(0) % total;
  let cursor = hash;
  for (const item of eligible) {
    cursor -= item.weight;
    if (cursor < 0) return item
  }
  return eligible[0]
}

export function choosePolicyTarget<T extends {
  policyPriority: number;
  priority: number;
  weight: number
}>(deliveryId: string, attempt: number, candidates: T[]) {
  if (!candidates.length) return undefined;
  const policyPriority = Math.min(...candidates.map(candidate => candidate.policyPriority));
  return chooseWeighted(deliveryId, attempt, candidates.filter(candidate => candidate.policyPriority === policyPriority))
}

function configuredLimit(quota: Record<string, unknown>, key: "monthlyLimit" | "dailyLimit") {
  const value = quota[key];
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function evaluateCandidate(row: {
  status: string; circuit_open_until: Date | null; account_status: string; health: Record<string, unknown>;
  identity_status: string; domain_status: string; quota: Record<string, unknown>; monthly_usage: string; daily_usage: string
}, now = new Date()) {
  const reasons: string[] = [];
  if (row.status === "circuit_open" && (!row.circuit_open_until || row.circuit_open_until > now)) reasons.push("circuit_open");
  if (row.account_status !== "active") reasons.push("account_unavailable");
  if (["unhealthy", "offline"].includes(String(row.health.status))) reasons.push("account_unhealthy");
  if (row.identity_status !== "verified") reasons.push("identity_unverified");
  if (row.domain_status !== "active") reasons.push("domain_disabled");
  for (const [key, usage, reason] of [["monthlyLimit", row.monthly_usage, "monthly_quota_exhausted"], ["dailyLimit", row.daily_usage, "daily_quota_exhausted"]] as const) {
    const limit = configuredLimit(row.quota, key);
    if (limit === null) reasons.push("invalid_quota");
    else if (limit !== undefined && Number(usage) >= limit) reasons.push(reason);
  }
  return reasons;
}

async function reserveProviderCapacity(client: PoolClient, candidate: Candidate, recipients: number) {
  const account = (await client.query<{ quota: Record<string, unknown> }>("SELECT quota FROM provider_accounts WHERE id=$1 FOR UPDATE", [candidate.provider_account_id])).rows[0];
  if (!account) return false;
  const monthly = configuredLimit(account.quota, "monthlyLimit");
  const daily = configuredLimit(account.quota, "dailyLimit");
  if (monthly === null || daily === null) return false;
  const usage = (await client.query<{ monthly: string; daily: string }>(`SELECT
    count(*) FILTER (WHERE a.started_at>=date_trunc('month',now())) AS monthly,
    count(*) FILTER (WHERE a.started_at>=date_trunc('day',now())) AS daily
    FROM submission_attempts a JOIN submission_deliveries sd ON sd.submission_id=a.submission_id
    WHERE a.provider_account_id=$1 AND a.status IN ('submitting','accepted','reconciled','unknown','reconciling')`, [candidate.provider_account_id])).rows[0];
  return (monthly === undefined || Number(usage.monthly) + recipients <= monthly) && (daily === undefined || Number(usage.daily) + recipients <= daily);
}

type Submission = { id: string; message_id: string; status: string; current_attempt_id: string | null; defer_count: number };
type Attempt = {
  id: string; submission_id: string; status: string; external_message_id: string | null; attempt_number: number;
  routing_snapshot: Record<string, unknown>; started_at: Date; reconciliation_count: number;
  retry_authorized_at: Date | null; is_current: boolean; submission_expired: boolean; content_policy: string; send_before: Date | null;
};
type Recipient = { id: string; recipient_email: string; recipient_name: string | null; lifecycle_status: string; compliance_status: string; current_attempt_id: string | null; current_submission_id: string | null };

async function recipients(client: PoolClient, submissionId: string) {
  return (await client.query<Recipient>(`SELECT d.* FROM submission_deliveries sd JOIN deliveries d ON d.id=sd.delivery_id
    WHERE sd.submission_id=$1 ORDER BY d.id FOR UPDATE OF d`, [submissionId])).rows;
}
async function enqueue(client: PoolClient, submissionId: string, seconds: number) {
  await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'submission',$2,'submission.requested',$3,now()+$4*interval '1 second')", [createId("out"), submissionId, { submissionId }, seconds]);
}
async function enqueueReconciliation(client: PoolClient, attemptId: string, seconds: number) {
  await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'attempt',$2,'submission.reconcile',$3,now()+$4*interval '1 second')", [createId("out"), attemptId, { attemptId }, seconds]);
}
async function emit(client: PoolClient, submissionId: string, type: DeliveryStateEvent["type"], key: string, error?: Diagnostic, attempt?: Attempt, occurredAt = new Date(), projectLifecycle = true) {
  const event: DeliveryStateEvent = { id: key, type, occurredAt, metadata: error ? { diagnostic: error } : {} };
  await applySubmissionEvent(client, submissionId, event, `${key}:submission`, attempt?.id);
  for (const row of await recipients(client, submissionId)) {
    if (!attempt && (row.current_submission_id !== submissionId || !["queued", "deferred"].includes(row.lifecycle_status))) continue;
    await applyDeliveryEvent(client, row.id, event, `${key}:${row.id}`, { attemptId: attempt?.id, projectLifecycle });
  }
}
async function routingFailure(client: PoolClient, submission: Submission, code: string, message: string, retryable: boolean) {
  const count = (await client.query<{ defer_count: number }>("UPDATE submissions SET defer_count=defer_count+1,updated_at=now() WHERE id=$1 RETURNING defer_count", [submission.id])).rows[0].defer_count;
  const retry = retryable && count < 60;
  const error = diagnostic(code, message, code === "SENDER_NOT_AUTHORIZED" ? "authorization" : "routing", { retryable, retryDecision: retry ? { action: "scheduled", nextAttemptAt: new Date(Date.now()+60_000).toISOString() } : { action: "none", reason: retryable ? "routing_retries_exhausted" : "configuration_or_policy" } });
  await client.query("UPDATE submissions SET status=$2 WHERE id=$1", [submission.id, retry ? "deferred" : "failed"]);
  await emit(client, submission.id, retry ? "deferred" : "failed", `submission:${submission.id}:route:${count}`, error);
  if (retry) await enqueue(client, submission.id, 60);
}

export async function prepareSubmission(submissionId: string): Promise<DeliverySubmission | { reconcileAttemptId: string } | null> {
  return transaction(async client => {
    const owner = (await client.query<{ message_id: string }>("SELECT message_id FROM submissions WHERE id=$1", [submissionId])).rows[0];
    if (!owner) return null;
    let message = (await client.query<MessageContent>("SELECT * FROM messages WHERE id=$1 FOR UPDATE", [owner.message_id])).rows[0];
    const submission = (await client.query<Submission>("SELECT * FROM submissions WHERE id=$1 FOR UPDATE", [submissionId])).rows[0];
    const latest = submission.current_attempt_id ? (await client.query<Attempt>(`SELECT a.*,s.current_attempt_id=a.id AS is_current,a.submission_deadline_at<=now() AS submission_expired
      FROM submission_attempts a JOIN submissions s ON s.id=a.submission_id WHERE a.id=$1 FOR UPDATE OF a`, [submission.current_attempt_id])).rows[0] : undefined;
    if (submission.status === "canceled") return null;
    if (latest?.status === "submitting") {
      if (!latest.submission_expired) return null;
      const error = diagnostic("INTERRUPTED_SUBMISSION", "The submission deadline expired before its outcome was recorded.", "submission", { acceptance: "unknown", retryDecision: { action: "manual_review", reason: "Reconciliation will check provider acceptance; automatic resubmission is blocked." } });
      await client.query("UPDATE submission_attempts SET status='unknown',outcome_determinate=false,error_category='unknown',error_code=$2,error_message=$3,diagnostic=$4,finished_at=now(),reconcile_after=now()+interval '30 seconds' WHERE id=$1", [latest.id, error.code, error.message, error]);
      await client.query("UPDATE submissions SET status='unknown',updated_at=now() WHERE id=$1", [submissionId]);
      await emit(client, submissionId, "unknown", `attempt:${latest.id}:unknown`, error, latest);
      await enqueueReconciliation(client, latest.id, 30);
      return { reconcileAttemptId: latest.id };
    }
    if (latest && ["unknown", "reconciling"].includes(latest.status)) return { reconcileAttemptId: latest.id };
    if (!["queued", "deferred"].includes(submission.status)) return null;
    const all = await recipients(client, submissionId);
    const active = all.filter(row => row.current_submission_id === submissionId && ["queued", "deferred"].includes(row.lifecycle_status) && row.current_attempt_id === (latest?.id ?? null));
    if (!active.length) { await client.query("UPDATE submissions SET status='canceled',updated_at=now() WHERE id=$1", [submissionId]); return null; }
    try { assertSendDeadline(message.send_before); }
    catch { await routingFailure(client, submission, DEADLINE_CODE, DEADLINE_MESSAGE, false); return null; }
    if (message.content_purged_at || !await authorizedDomain(client, { productId: message.product_id, serviceId: message.service_id }, message.sender_snapshot.fromEmail)) {
      await routingFailure(client, submission, message.content_purged_at ? "CONTENT_EXPIRED" : "SENDER_NOT_AUTHORIZED", message.content_purged_at ? "The retained message content has expired." : "The sender authorization is no longer active.", false);
      return null;
    }
    message = sendingContent(message);
    const allowed: Recipient[] = [];
    for (const recipient of active) {
      if (recipient.compliance_status !== "clean" || await isSuppressed(client, message.product_id, recipient.recipient_email, message.metadata.listId)) {
        await applyDeliveryEvent(client, recipient.id, { id: createId("sup"), type: "suppressed", occurredAt: new Date(), metadata: {} }, `submission:${submissionId}:suppressed:${recipient.id}`);
      } else allowed.push(recipient);
    }
    if (!allowed.length) { await client.query("UPDATE submissions SET status='canceled',updated_at=now() WHERE id=$1", [submissionId]); return null; }
    if (allowed.length !== all.length) {
      // A logical submission has an immutable envelope and provider idempotency key.
      // Fork when suppression, cancellation, or targeted retry changes its membership.
      await client.query("UPDATE submissions SET status='canceled',updated_at=now() WHERE id=$1", [submissionId]);
      await createSubmission(client, message.id, allowed.map(row => row.id));
      return null;
    }
    const envelope = subsetEnvelope(message, allowed.map(row => ({ email: row.recipient_email, name: row.recipient_name ?? undefined })));
    const candidates = (await client.query<Candidate>(`SELECT rt.id AS target_id,rp.id AS policy_id,rp.name AS policy_name,rp.priority AS policy_priority,rt.provider_account_id,rt.provider_identity_id,
      pa.type AS provider_type,pa.name AS provider_name,rt.priority,rt.weight,rt.rate_limit_per_minute,sd.domain,pa.quota,rt.status,rt.circuit_open_until,pa.status AS account_status,pa.health,pi.status AS identity_status,sd.status AS domain_status,
      usage.monthly_usage::text,usage.daily_usage::text
      FROM routing_policies rp JOIN routing_targets rt ON rt.policy_id=rp.id
      JOIN provider_accounts pa ON pa.id=rt.provider_account_id JOIN provider_identities pi ON pi.id=rt.provider_identity_id
      JOIN sending_domains sd ON sd.id=pi.sending_domain_id
      CROSS JOIN LATERAL (SELECT count(*) FILTER (WHERE a.started_at>=date_trunc('month',now())) AS monthly_usage,
        count(*) FILTER (WHERE a.started_at>=date_trunc('day',now())) AS daily_usage
        FROM submission_attempts a JOIN submission_deliveries sm ON sm.submission_id=a.submission_id
        WHERE a.provider_account_id=pa.id AND a.status IN ('submitting','accepted','reconciled','unknown','reconciling')) usage
      WHERE rp.status='active' AND rp.sending_domain_id=$1 AND pi.sending_domain_id=$1 AND pi.provider_account_id=pa.id
        AND (rp.product_id IS NULL OR rp.product_id=$2) AND (rp.service_id IS NULL OR rp.service_id=$3)
        AND (rp.message_category IS NULL OR rp.message_category=$4)
      ORDER BY rp.priority,rt.priority,rt.id`, [message.sending_domain_id, message.product_id, message.service_id, message.message_category])).rows;
    const compatible = candidates.filter(row => !capabilityIssue(message, providerRegistry(row.provider_type).descriptor.capabilities, envelope));
    if (!compatible.length) {
      await routingFailure(client, submission, "UNSUPPORTED_MESSAGE_CAPABILITY", "No configured provider can preserve the message fields and recipient envelope.", false); return null;
    }
    const attemptNumber = (latest?.attempt_number ?? 0) + 1;
    // Determinate rejections may fail over; uncertainty never reaches this branch.
    const failedAccounts = (await client.query<{ provider_account_id: string }>("SELECT DISTINCT provider_account_id FROM submission_attempts WHERE submission_id=$1 AND status='failed'", [submissionId])).rows.map(row => row.provider_account_id);
    const healthy = compatible.filter(row => !evaluateCandidate(row).length);
    let pool = healthy.some(row => !failedAccounts.includes(row.provider_account_id)) ? healthy.filter(row => !failedAccounts.includes(row.provider_account_id)) : healthy;
    let selected: Candidate | undefined;
    while (pool.length) {
      const pick = choosePolicyTarget(submissionId, attemptNumber, pool.map(row => ({ ...row, policyPriority: row.policy_priority })))!;
      await client.query("SAVEPOINT routing_capacity");
      if (await reserveProviderCapacity(client, pick, allowed.length) && await reserveRateLimits(client, [
        { scope: "provider", key: pick.provider_account_id, limit: pick.rate_limit_per_minute, units: allowed.length },
        { scope: "identity", key: pick.provider_identity_id, limit: pick.rate_limit_per_minute, units: allowed.length },
      ])) { await client.query("RELEASE SAVEPOINT routing_capacity"); selected = pick; break; }
      await client.query("ROLLBACK TO SAVEPOINT routing_capacity");
      await client.query("RELEASE SAVEPOINT routing_capacity");
      pool = pool.filter(row => row.target_id !== pick.target_id);
    }
    if (!selected) { await routingFailure(client, submission, "ROUTE_TEMPORARILY_UNAVAILABLE", "No healthy routing target has sufficient quota or rate capacity.", true); return null; }
    try { assertSendDeadline(message.send_before); }
    catch { await routingFailure(client, submission, DEADLINE_CODE, DEADLINE_MESSAGE, false); return null; }
    const attemptId = createId("att");
    const nativeIdempotency = providerRegistry(selected.provider_type).descriptor.capabilities.nativeIdempotency;
    const providerIdempotencyKey = nativeIdempotency ? `envoy/${submissionId}/${selected.provider_account_id}` : null;
    const canonical = { ...canonicalMessage(message, submissionId, envelope), rfcMessageId: `<${attemptId}@${message.sender_snapshot.fromEmail.split("@")[1]}>` };
    const fingerprintInput = JSON.stringify({ ...canonical, attachments: message.attachment_snapshot });
    const fingerprint = message.content_policy === "sensitive" ? secretDigest(fingerprintInput, `provider-request:${message.id}`, message.payload_hash_key_version ?? undefined).digest : createHash("sha256").update(fingerprintInput).digest("hex");
    const snapshot = {
      policy: { id: selected.policy_id, name: selected.policy_name, priority: selected.policy_priority },
      chosen: { targetId: selected.target_id, accountId: selected.provider_account_id, identityId: selected.provider_identity_id, providerType: selected.provider_type, nativeIdempotency },
      candidates: candidates.map(row => ({ targetId: row.target_id, policyId: row.policy_id, policyPriority: row.policy_priority, accountId: row.provider_account_id, identityId: row.provider_identity_id, priority: row.priority, weight: row.weight, reasons: evaluateCandidate(row), capabilityIssue: capabilityIssue(message, providerRegistry(row.provider_type).descriptor.capabilities, envelope) })),
      selectedAt: new Date().toISOString(), recipientCount: allowed.length,
    };
    await client.query("UPDATE routing_targets SET status='active',circuit_open_until=NULL,updated_at=now() WHERE id=$1 AND status='circuit_open'", [selected.target_id]);
    await client.query(`INSERT INTO submission_attempts(id,submission_id,attempt_number,provider_account_id,provider_identity_id,routing_snapshot,request_fingerprint,provider_idempotency_key,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'submitting')`, [attemptId, submissionId, attemptNumber, selected.provider_account_id, selected.provider_identity_id, snapshot, fingerprint, providerIdempotencyKey]);
    await client.query("UPDATE submissions SET status='submitting',current_attempt_id=$2,updated_at=now() WHERE id=$1", [submissionId, attemptId]);
    for (const row of allowed) {
      await client.query("UPDATE deliveries SET current_attempt_id=$2 WHERE id=$1", [row.id, attemptId]);
      await applyDeliveryEvent(client, row.id, { id: attemptId, type: "submitting", occurredAt: new Date(), metadata: {} }, `attempt:${attemptId}:${row.id}:submitting`, { attemptId, forceLifecycle: true });
    }
    await applySubmissionEvent(client, submissionId, { id: attemptId, type: "submitting", occurredAt: new Date(), metadata: {} }, `attempt:${attemptId}:submitting`, attemptId);
    return { attemptId, attemptNumber, submissionId, messageId: message.id, providerAccountId: selected.provider_account_id, providerIdentityId: selected.provider_identity_id, providerType: selected.provider_type, providerName: selected.provider_name, providerIdempotencyKey, requestFingerprint: fingerprint, routingSnapshot: snapshot, message: canonical, attachments: message.attachment_snapshot, sendBefore: message.send_before ?? null, sensitive: message.content_policy === "sensitive" };
  });
}

async function lockAttempt(client: PoolClient, attemptId: string): Promise<Attempt | null> {
  const owner = (await client.query<{ submission_id: string; message_id: string }>("SELECT a.submission_id,s.message_id FROM submission_attempts a JOIN submissions s ON s.id=a.submission_id WHERE a.id=$1", [attemptId])).rows[0];
  if (!owner) return null;
  await client.query("SELECT id FROM messages WHERE id=$1 FOR UPDATE", [owner.message_id]);
  await client.query("SELECT id FROM submissions WHERE id=$1 FOR UPDATE", [owner.submission_id]);
  return (await client.query<Attempt>(`SELECT a.*,s.current_attempt_id=a.id AS is_current,a.submission_deadline_at<=now() AS submission_expired,m.content_policy,m.send_before
    FROM submission_attempts a JOIN submissions s ON s.id=a.submission_id JOIN messages m ON m.id=s.message_id WHERE a.id=$1 FOR UPDATE OF a`, [attemptId])).rows[0] ?? null;
}

export async function markAccepted(attemptId: string, externalMessageId: string, response: Record<string, unknown> = {}, rfcMessageId: string | null = null) {
  await transaction(async client => {
    const row = await lockAttempt(client, attemptId);
    if (!row || !["submitting", "unknown", "reconciling", "reconciled"].includes(row.status) || (row.status === "reconciled" && row.external_message_id)) return;
    await client.query("UPDATE submission_attempts SET status='accepted',outcome_determinate=true,external_message_id=$2,provider_response_ref=$3,rfc_message_id=$4,finished_at=now(),reconcile_after=NULL,diagnostic=NULL,error_category=NULL,error_code=NULL,error_message=NULL WHERE id=$1", [attemptId, externalMessageId, JSON.stringify(row.content_policy === "sensitive" ? {} : response), rfcMessageId]);
    if (row.is_current) await client.query("UPDATE submissions SET status='accepted',updated_at=now() WHERE id=$1", [row.submission_id]);
    await emit(client, row.submission_id, "accepted", `attempt:${attemptId}:accepted`, undefined, row, row.started_at);
    const targetId = ((row.routing_snapshot.chosen ?? {}) as Record<string, unknown>).targetId;
    if (typeof targetId === "string") await client.query("UPDATE routing_targets SET status='active',circuit_open_until=NULL,updated_at=now() WHERE id=$1", [targetId]);
  });
}

export async function markUnknown(attemptId: string, message: string, details: { providerCode?: string; smtpStatus?: string; stage?: string } = {}) {
  await transaction(async client => {
    const row = await lockAttempt(client, attemptId);
    if (!row || row.status !== "submitting") return;
    const error = diagnostic("SUBMISSION_OUTCOME_UNKNOWN", row.content_policy === "sensitive" ? "Provider submission outcome is unknown." : safeDiagnostic(message), details.stage ?? "submission", { acceptance: "unknown", providerCode: row.content_policy === "sensitive" ? undefined : details.providerCode, smtpStatus: row.content_policy === "sensitive" ? undefined : details.smtpStatus, retryDecision: { action: "manual_review", reason: "Automatic resubmission is blocked until provider acceptance is determined." } });
    await client.query("UPDATE submission_attempts SET status='unknown',outcome_determinate=false,error_category='unknown',error_code=$2,error_message=$3,diagnostic=$4,finished_at=now(),reconcile_after=now()+interval '30 seconds' WHERE id=$1", [attemptId, error.code, error.message, error]);
    if (row.is_current) await client.query("UPDATE submissions SET status='unknown',updated_at=now() WHERE id=$1", [row.submission_id]);
    await emit(client, row.submission_id, "unknown", `attempt:${attemptId}:unknown`, error, row);
    if (row.is_current) await enqueueReconciliation(client, attemptId, 30);
  });
}

export async function markDeterminateFailure(attemptId: string, failure: { category: string; code: string; message: string; stage?: string; providerCode?: string; smtpStatus?: string }, retryable: boolean) {
  return transaction(async client => {
    const row = await lockAttempt(client, attemptId);
    if (!row || row.status !== "submitting") return null;
    const expired = Boolean(row.send_before && row.send_before.getTime() <= Date.now());
    if (expired) { failure = { category: "policy", code: DEADLINE_CODE, message: DEADLINE_MESSAGE, stage: "submission" }; retryable = false; }
    const retry = !expired && row.is_current && retryable && row.attempt_number < 5;
    const delay = Math.min(300, 5 * 2 ** (row.attempt_number-1));
    const error = diagnostic(failure.code, row.content_policy === "sensitive" && !expired ? "Provider submission was not accepted." : safeDiagnostic(failure.message), failure.stage ?? "submission", { retryable, acceptance: "not_accepted", providerCode: row.content_policy === "sensitive" ? undefined : failure.providerCode, smtpStatus: row.content_policy === "sensitive" ? undefined : failure.smtpStatus, retryDecision: retry ? { action: "scheduled", nextAttemptAt: new Date(Date.now()+delay*1000).toISOString() } : { action: "none", reason: retryable ? "attempts_exhausted" : "not_retryable" } });
    await client.query("UPDATE submission_attempts SET status='failed',outcome_determinate=true,error_category=$2,error_code=$3,error_message=$4,diagnostic=$5,finished_at=now(),reconcile_after=NULL WHERE id=$1", [attemptId, failure.category, error.code, error.message, error]);
    if (row.is_current) await client.query("UPDATE submissions SET status=$2,updated_at=now() WHERE id=$1", [row.submission_id, retry ? "deferred" : "failed"]);
    const targetId = ((row.routing_snapshot.chosen ?? {}) as Record<string, unknown>).targetId;
    const threshold = positiveInteger(process.env.ENVOY_CIRCUIT_FAILURE_THRESHOLD, 5);
    if (retryable && typeof targetId === "string" && ["network", "provider", "rate_limit"].includes(failure.category)) {
      const sample = (await client.query<{ sample_count: string; all_failed: boolean }>("SELECT count(*)::text AS sample_count,COALESCE(bool_and(status='failed' AND error_category=ANY($2::text[])),false) AS all_failed FROM (SELECT status,error_category FROM submission_attempts WHERE routing_snapshot#>>'{chosen,targetId}'=$1 ORDER BY started_at DESC LIMIT $3) samples", [targetId, ["network", "provider", "rate_limit"], threshold])).rows[0];
      if (Number(sample.sample_count) === threshold && sample.all_failed) await client.query("UPDATE routing_targets SET status='circuit_open',circuit_open_until=now()+$2*interval '1 second',updated_at=now() WHERE id=$1", [targetId, positiveInteger(process.env.ENVOY_CIRCUIT_OPEN_SECONDS, 300)]);
    }
    await emit(client, row.submission_id, retry ? "deferred" : "failed", `attempt:${attemptId}:failure`, error, row);
    if (retry) await enqueue(client, row.submission_id, delay);
    return row.submission_id;
  });
}

export async function getAttemptForReconciliation(attemptId: string) {
  return (await query<{ id: string; submission_id: string; provider_account_id: string; external_message_id: string | null; request_fingerprint: string; status: string }>(`UPDATE submission_attempts a SET reconciliation_count=reconciliation_count+1,reconcile_after=now()+interval '2 minutes'
    FROM submissions s WHERE a.id=$1 AND s.current_attempt_id=a.id AND a.status IN ('unknown','reconciling')
      AND EXISTS(SELECT 1 FROM deliveries d WHERE d.current_attempt_id=a.id AND d.current_submission_id=a.submission_id) AND a.reconcile_after<=now() AND a.reconciliation_count<12
    RETURNING a.id,a.submission_id,a.provider_account_id,a.external_message_id,a.request_fingerprint,a.status`, [attemptId])).rows[0] ?? null;
}

export async function markReconciled(attemptId: string, outcome: "accepted" | "not_accepted" | "unknown") {
  await transaction(async client => {
    const row = await lockAttempt(client, attemptId);
    if (!row || !["unknown", "reconciling"].includes(row.status)) return;
    if (outcome === "unknown") {
      const exhausted = row.reconciliation_count >= 12;
      await client.query("UPDATE submission_attempts SET status=$2,reconcile_after=CASE WHEN $3 THEN NULL ELSE now()+interval '5 minutes' END WHERE id=$1", [attemptId, exhausted ? "unknown" : "reconciling", exhausted]);
      if (exhausted) {
        const error = diagnostic("RECONCILIATION_EXHAUSTED", "Provider acceptance could not be determined after reconciliation. Review before authorizing a retry.", "reconciliation", { acceptance: "unknown", retryDecision: { action: "manual_review", reason: "reconciliation_exhausted" } });
        await client.query("UPDATE submission_attempts SET diagnostic=$2,error_code=$3,error_message=$4 WHERE id=$1", [attemptId, error, error.code, error.message]);
        await emit(client, row.submission_id, "unknown", `attempt:${attemptId}:reconciliation_exhausted`, error, row);
      } else if (row.is_current) await enqueueReconciliation(client, attemptId, 300);
      return;
    }
    const expired = Boolean(row.send_before && row.send_before.getTime() <= Date.now());
    const retry = !expired && outcome === "not_accepted" && row.is_current && row.attempt_number < 5;
    const error = outcome === "not_accepted" ? diagnostic(expired ? DEADLINE_CODE : "PROVIDER_NOT_ACCEPTED", expired ? DEADLINE_MESSAGE : "Reconciliation confirmed the provider did not accept the message.", "reconciliation", { retryable: !expired, retryDecision: retry ? { action: "scheduled", nextAttemptAt: new Date(Date.now()+5000).toISOString() } : { action: "none", reason: expired ? "send_deadline_exceeded" : "attempts_exhausted" } }) : undefined;
    await client.query("UPDATE submission_attempts SET status=$2,outcome_determinate=true,finished_at=now(),reconcile_after=NULL,diagnostic=$3,error_category=CASE WHEN $2='reconciled' THEN NULL ELSE error_category END,error_code=CASE WHEN $2='reconciled' THEN NULL ELSE error_code END,error_message=CASE WHEN $2='reconciled' THEN NULL ELSE error_message END WHERE id=$1", [attemptId, outcome === "accepted" ? "reconciled" : "failed", error ?? null]);
    if (row.is_current) await client.query("UPDATE submissions SET status=$2,updated_at=now() WHERE id=$1", [row.submission_id, outcome === "accepted" ? "accepted" : retry ? "deferred" : "failed"]);
    await emit(client, row.submission_id, outcome === "accepted" ? "accepted" : retry ? "deferred" : "failed", `attempt:${attemptId}:reconciled:${outcome}`, error, row, outcome === "accepted" ? row.started_at : new Date());
    if (retry) await enqueue(client, row.submission_id, 5);
  });
}

export async function recordWorkflowFailure(submissionId: string, message: string) {
  await transaction(async client => {
    const owner = (await client.query<{ message_id: string }>("SELECT message_id FROM submissions WHERE id=$1", [submissionId])).rows[0];
    if (!owner) return;
    const content = (await client.query<{ content_policy: string }>("SELECT content_policy FROM messages WHERE id=$1 FOR UPDATE", [owner.message_id])).rows[0];
    const row = (await client.query<Submission>("SELECT * FROM submissions WHERE id=$1 FOR UPDATE", [submissionId])).rows[0];
    if (!["queued", "deferred"].includes(row.status)) return;
    const error = diagnostic("WORKFLOW_EXHAUSTED", content.content_policy === "sensitive" ? "Message workflow requires review." : safeDiagnostic(message), "queue", { retryable: true, retryDecision: { action: "manual_review", reason: "The task exhausted infrastructure retries; retry the failed task or use the message retry API." } });
    await client.query("UPDATE submissions SET status='deferred',updated_at=now() WHERE id=$1", [submissionId]);
    await emit(client, submissionId, "deferred", `submission:${submissionId}:workflow_exhausted`, error);
  });
}

export { getDeliveryRetryEligibility as getRetryEligibility, retryDelivery } from "@/modules/core/message/service";
