import { createHash } from "node:crypto";
import type { ProviderType } from "@/modules/providers/contracts";
import { providerRegistry } from "@/modules/providers/registry";
import { query, transaction } from "@/server/database";
import { createId } from "@/server/ids";
import { reserveRateLimits } from "@/server/runtime-store";
import { applyDeliveryEvent } from "@/modules/core/event/service";

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
  attemptId: string;
  attemptNumber: number;
  deliveryId: string;
  messageId: string;
  providerAccountId: string;
  providerIdentityId: string;
  providerType: string;
  providerName: string;
  providerIdempotencyKey: string | null;
  requestFingerprint: string;
  routingSnapshot: Record<string, unknown>;
  recipientEmail: string;
  recipientName: string | null;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  subject: string;
  html: string;
  text: string;
  product: string;
  category: string;
  tags: Record<string, string>
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

async function reserveProviderCapacity(client: import("pg").PoolClient, candidate: Candidate) {
  const account = await client.query<{
    quota: Record<string, unknown>
  }>("SELECT quota FROM provider_accounts WHERE id=$1 FOR UPDATE", [candidate.provider_account_id]);
  const quota = account.rows[0]?.quota ?? {};
  const monthlyLimit = configuredLimit(quota, "monthlyLimit");
  const dailyLimit = configuredLimit(quota, "dailyLimit");
  if (monthlyLimit === null || dailyLimit === null) return false;
  if (monthlyLimit === undefined && dailyLimit === undefined) return true;
  const usage = await client.query<{ monthly: string; daily: string }>(`SELECT
    count(*) FILTER (WHERE started_at>=date_trunc('month',now())) AS monthly,
    count(*) FILTER (WHERE started_at>=date_trunc('day',now())) AS daily
    FROM delivery_attempts WHERE provider_account_id=$1 AND status IN ('submitting','accepted','reconciled','unknown','reconciling')`, [candidate.provider_account_id]);
  const row = usage.rows[0];
  return (monthlyLimit === undefined || Number(row.monthly) < monthlyLimit) && (dailyLimit === undefined || Number(row.daily) < dailyLimit);
}

async function deferDelivery(client: import("pg").PoolClient, deliveryId: string, reason: string) {
  const row = (await client.query<{ defer_count: number }>("UPDATE deliveries SET defer_count=defer_count+1 WHERE id=$1 RETURNING defer_count", [deliveryId])).rows[0];
  const exhausted = row.defer_count >= 60;
  await applyDeliveryEvent(client, deliveryId, { id: `defer:${row.defer_count}`, type: exhausted ? "failed" : "deferred", occurredAt: new Date(), metadata: { reason, source: "routing", exhausted } }, `delivery:${deliveryId}:defer:${row.defer_count}`);
  if (!exhausted) await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'delivery',$2,'delivery.requested',$3,now()+interval '1 minute')", [createId("out"), deliveryId, { deliveryId, reason }]);
}

export async function prepareSubmission(deliveryId: string): Promise<DeliverySubmission | {
  reconcileAttemptId: string
} | null> {
  return transaction(async client => {
    const deliveryResult = await client.query<{
      id: string;
      message_id: string;
      recipient_email: string;
      recipient_name: string | null;
      lifecycle_status: string;
      product_id: string;
      service_id: string;
      sender_profile_id: string;
      category: string;
      product: string;
      payload_hash: string;
      subject: string;
      html_body: string | null;
      text_body: string | null;
      provider_tags: Record<string, string>;
      from_name: string;
      from_email: string;
      from_local_part: string;
      reply_to: string | null;
      sending_domain_id: string;
      enabled: boolean;
      content_expired: boolean;
      compliance_status: string;
      blocked: boolean
    }>(`SELECT d.id,d.message_id,d.recipient_email,d.recipient_name,d.lifecycle_status,m.product_id,m.service_id,m.sender_profile_id,
      m.message_category AS category,p.name AS product,m.payload_hash,m.subject,m.html_body,m.text_body,m.provider_tags,
      m.sender_snapshot->>'fromName' AS from_name,m.sender_snapshot->>'fromEmail' AS from_email,split_part(m.sender_snapshot->>'fromEmail','@',1) AS from_local_part,m.reply_to,m.sender_snapshot->>'domainId' AS sending_domain_id,
      m.content_purged_at IS NOT NULL AS content_expired,(p.status='active' AND sp.status='active' AND sd.status='active') AS enabled,d.compliance_status,
      EXISTS(SELECT 1 FROM suppressions su WHERE su.active AND su.email_normalized=d.recipient_email
        AND (su.expires_at IS NULL OR su.expires_at>now()) AND (su.scope_type='global' OR (su.product_id=m.product_id AND (su.scope_type='product' OR su.list_id=m.metadata->>'listId')))) AS blocked
      FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN products p ON p.id=m.product_id
      JOIN sender_profiles sp ON sp.id=m.sender_profile_id JOIN sending_domains sd ON sd.id=(m.sender_snapshot->>'domainId') WHERE d.id=$1 FOR UPDATE OF d`, [deliveryId]);
    const delivery = deliveryResult.rows[0];
    if (!delivery) return null;
    const last = await client.query<{
      id: string;
      status: string;
      outcome_determinate: boolean;
      external_message_id: string | null;
      attempt_number: number;
      submission_expired: boolean;
      retry_authorized_at: Date | null;
      reconcile_after: Date | null
    }>("SELECT id,status,outcome_determinate,external_message_id,attempt_number,submission_deadline_at<=now() AS submission_expired,retry_authorized_at,reconcile_after FROM delivery_attempts WHERE delivery_id=$1 ORDER BY attempt_number DESC LIMIT 1", [deliveryId]);
    const latest = last.rows[0];
    if (latest?.status === "submitting") {
      if (!latest.submission_expired) return null;
      await client.query("UPDATE delivery_attempts SET status='unknown',outcome_determinate=false,error_category='unknown',error_code='interrupted_submission',error_message='Submission execution deadline expired',finished_at=now(),reconcile_after=now()+interval '30 seconds' WHERE id=$1", [latest.id]);
      await applyDeliveryEvent(client, deliveryId, { id: latest.id, type: "unknown", occurredAt: new Date(), metadata: { reason: "interrupted_submission" } }, `attempt:${latest.id}:unknown`, { attemptId: latest.id });
      await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'attempt',$2,'delivery.reconcile',$3,now()+interval '30 seconds')", [createId("out"), latest.id, { attemptId: latest.id }]);
      return { reconcileAttemptId: latest.id };
    }
    // Authorization preserves the old uncertainty; only an explicit caller decision permits a new submission.
    if (latest && ["unknown", "reconciling"].includes(latest.status) && !latest.retry_authorized_at) return { reconcileAttemptId: latest.id };
    if (!["queued", "deferred"].includes(delivery.lifecycle_status)) return null;
    if (delivery.blocked || delivery.compliance_status !== "clean") {
      await applyDeliveryEvent(client, deliveryId, { id: deliveryId, type: "suppressed", occurredAt: new Date(), metadata: { source: "submission_policy" } }, `suppression:${deliveryId}`);
      return null;
    }
    if (!delivery.enabled || delivery.content_expired) {
      await applyDeliveryEvent(client, deliveryId, { id: deliveryId, type: "failed", occurredAt: new Date(), metadata: { reason: delivery.content_expired ? "content_expired" : "configuration_disabled" } }, `delivery:${deliveryId}:configuration_disabled`);
      return null;
    }
    const prior = await client.query<{
      provider_account_id: string
    }>("SELECT provider_account_id FROM delivery_attempts WHERE delivery_id=$1 AND outcome_determinate=true AND status='failed' AND retry_authorized_at IS NULL", [deliveryId]);
    const excluded = prior.rows.map(r => r.provider_account_id);
    const candidates = await client.query<Candidate>(`SELECT rt.id AS target_id,rp.id AS policy_id,rp.name AS policy_name,rp.priority AS policy_priority,rt.provider_account_id,rt.provider_identity_id,
      pa.type AS provider_type,pa.name AS provider_name,rt.priority,rt.weight,rt.rate_limit_per_minute,sd.domain,pa.quota,rt.status,rt.circuit_open_until,pa.status AS account_status,pa.health,pi.status AS identity_status,sd.status AS domain_status,
      usage.monthly_usage::text,usage.daily_usage::text
      FROM routing_policies rp JOIN routing_targets rt ON rt.policy_id=rp.id
      JOIN provider_accounts pa ON pa.id=rt.provider_account_id JOIN provider_identities pi ON pi.id=rt.provider_identity_id
      JOIN sending_domains sd ON sd.id=pi.sending_domain_id
      CROSS JOIN LATERAL (SELECT
        count(*) FILTER (WHERE da.started_at>=date_trunc('month',now()) AND da.status IN ('submitting','accepted','reconciled','unknown','reconciling')) AS monthly_usage,
        count(*) FILTER (WHERE da.started_at>=date_trunc('day',now()) AND da.status IN ('submitting','accepted','reconciled','unknown','reconciling')) AS daily_usage
        FROM delivery_attempts da WHERE da.provider_account_id=pa.id) usage
      WHERE rp.status='active' AND rp.sending_domain_id=$1 AND pi.sending_domain_id=$1 AND pi.provider_account_id=pa.id
        AND (rp.product_id IS NULL OR rp.product_id=$2) AND (rp.service_id IS NULL OR rp.service_id=$3)
        AND (rp.message_category IS NULL OR rp.message_category=$4)
        AND (cardinality($5::text[])=0 OR NOT (rt.provider_account_id=ANY($5::text[])))
      ORDER BY rp.priority,rt.priority,rt.id`, [delivery.sending_domain_id, delivery.product_id, delivery.service_id, delivery.category, excluded]);
    const eligibleCandidates = candidates.rows.filter(candidate => evaluateCandidate(candidate).length === 0);
    if (!eligibleCandidates.length) {
      await deferDelivery(client, deliveryId, "No healthy verified routing target is available");
      return null
    }
    const attemptNumber = (last.rows[0]?.attempt_number ?? 0) + 1;
    let pool = eligibleCandidates;
    let selected: Candidate | undefined;
    while (pool.length) {
      const pick = choosePolicyTarget(deliveryId, attemptNumber, pool.map(candidate => ({
        ...candidate,
        policyPriority: candidate.policy_priority
      })));
      if (!pick) break;
      await client.query("SAVEPOINT routing_capacity");
      if (await reserveProviderCapacity(client, pick) && await reserveRateLimits(client, [{ scope: "provider", key: pick.provider_account_id, limit: pick.rate_limit_per_minute }, { scope: "identity", key: pick.provider_identity_id, limit: pick.rate_limit_per_minute }])) {
        await client.query("RELEASE SAVEPOINT routing_capacity");
        selected = pick;
        break;
      }
      // Release a rejected candidate's account lock before trying another account.
      await client.query("ROLLBACK TO SAVEPOINT routing_capacity");
      await client.query("RELEASE SAVEPOINT routing_capacity");
      pool = pool.filter(c => c.target_id !== pick.target_id)
    }
    if (!selected) {
      await deferDelivery(client, deliveryId, "All routing targets are quota exhausted or rate limited");
      return null
    }
    const attemptId = createId("att");
    const nativeIdempotency = providerRegistry(selected.provider_type).descriptor.capabilities.nativeIdempotency;
    const providerIdempotencyKey = nativeIdempotency ? `envoy/${deliveryId}/${attemptNumber}` : null;
    const fingerprint = createHash("sha256").update(JSON.stringify({
      deliveryId,
      attemptNumber,
      to: delivery.recipient_email,
      payloadHash: delivery.payload_hash,
      from: delivery.from_email
    })).digest("hex");
    const snapshot = {
      policy: {
        id: selected.policy_id,
        name: selected.policy_name,
        priority: selected.policy_priority
      },
      chosen: {
        targetId: selected.target_id,
        accountId: selected.provider_account_id,
        identityId: selected.provider_identity_id,
        providerType: selected.provider_type,
        nativeIdempotency
      },
      candidates: candidates.rows.map(c => ({
        targetId: c.target_id,
        policyId: c.policy_id,
        policyPriority: c.policy_priority,
        accountId: c.provider_account_id,
        identityId: c.provider_identity_id,
        priority: c.priority,
        weight: c.weight,
        quota: c.quota,
        monthlyUsage: Number(c.monthly_usage),
        dailyUsage: Number(c.daily_usage)
      })),
      excludedAccounts: excluded,
      selectedAt: new Date().toISOString()
    };
    await client.query("UPDATE routing_targets SET status='active',circuit_open_until=NULL,updated_at=now() WHERE id=$1 AND status='circuit_open'", [selected.target_id]);
    await client.query(`INSERT INTO delivery_attempts(id,delivery_id,attempt_number,provider_account_id,provider_identity_id,routing_snapshot,request_fingerprint,provider_idempotency_key,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'submitting')`, [attemptId, deliveryId, attemptNumber, selected.provider_account_id, selected.provider_identity_id, snapshot, fingerprint, providerIdempotencyKey]);
    await client.query("UPDATE deliveries SET current_attempt_id=$2 WHERE id=$1", [deliveryId, attemptId]);
    await applyDeliveryEvent(client, deliveryId, { id: attemptId, type: "submitting", occurredAt: new Date(), metadata: {} }, `attempt:${attemptId}:submitting`, { attemptId, forceLifecycle: true });
    return {
      attemptId,
      attemptNumber,
      deliveryId,
      messageId: delivery.message_id,
      providerAccountId: selected.provider_account_id,
      providerIdentityId: selected.provider_identity_id,
      providerType: selected.provider_type,
      providerName: selected.provider_name,
      providerIdempotencyKey,
      requestFingerprint: fingerprint,
      routingSnapshot: snapshot,
      recipientEmail: delivery.recipient_email,
      recipientName: delivery.recipient_name,
      fromName: delivery.from_name,
      fromEmail: delivery.from_email,
      replyTo: delivery.reply_to,
      subject: delivery.subject,
      html: delivery.html_body ?? "",
      text: delivery.text_body ?? "",
      product: delivery.product,
      category: delivery.category,
      tags: delivery.provider_tags
    };
  });
}

async function lockAttempt(client: import("pg").PoolClient, attemptId: string) {
  // Consistent delivery -> attempt lock order also fences events and manual retries.
  const owner = (await client.query<{ delivery_id: string }>("SELECT delivery_id FROM delivery_attempts WHERE id=$1", [attemptId])).rows[0];
  if (!owner) return null;
  await client.query("SELECT 1 FROM deliveries WHERE id=$1 FOR UPDATE", [owner.delivery_id]);
  return (await client.query<{
    id: string; delivery_id: string; status: string; external_message_id: string | null; attempt_number: number; routing_snapshot: Record<string, unknown>;
    is_current: boolean; started_at: Date; reconciliation_count: number; retry_authorized_at: Date | null
  }>("SELECT a.id,a.delivery_id,a.status,a.external_message_id,a.attempt_number,a.routing_snapshot,a.started_at,a.reconciliation_count,a.retry_authorized_at,d.current_attempt_id=a.id AS is_current FROM delivery_attempts a JOIN deliveries d ON d.id=a.delivery_id WHERE a.id=$1 FOR UPDATE OF a", [attemptId])).rows[0] ?? null;
}

export async function markAccepted(attemptId: string, externalMessageId: string, response: Record<string, unknown> = {}) {
  await transaction(async client => {
    const row = await lockAttempt(client, attemptId);
    if (!row || !["submitting", "unknown", "reconciling", "reconciled"].includes(row.status) || (row.status === "reconciled" && row.external_message_id)) return;
    await client.query("UPDATE delivery_attempts SET status='accepted',outcome_determinate=true,external_message_id=$2,provider_response_ref=$3,finished_at=now(),reconcile_after=NULL WHERE id=$1", [attemptId, externalMessageId, JSON.stringify(response)]);
    await applyDeliveryEvent(client, row.delivery_id, { id: attemptId, type: "accepted", occurredAt: row.started_at, metadata: { source: "provider_submission" } }, `attempt:${attemptId}:accepted`, { attemptId });
    const targetId = ((row.routing_snapshot.chosen ?? {}) as Record<string, unknown>).targetId;
    if (typeof targetId === "string") await client.query("UPDATE routing_targets SET status='active',circuit_open_until=NULL,updated_at=now() WHERE id=$1", [targetId]);
  });
}

export async function markUnknown(attemptId: string, message: string) {
  await transaction(async client => {
    const row = await lockAttempt(client, attemptId);
    if (!row || row.status !== "submitting") return;
    await client.query("UPDATE delivery_attempts SET status='unknown',outcome_determinate=false,error_category='unknown',error_message=$2,finished_at=now(),reconcile_after=now()+interval '30 seconds' WHERE id=$1", [attemptId, message]);
    await applyDeliveryEvent(client, row.delivery_id, { id: attemptId, type: "unknown", occurredAt: new Date(), metadata: { reason: message } }, `attempt:${attemptId}:unknown`, { attemptId });
    if (row.is_current) await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'attempt',$2,'delivery.reconcile',$3,now()+interval '30 seconds')", [createId("out"), attemptId, { attemptId }]);
  });
}

export async function markDeterminateFailure(attemptId: string, error: { category: string; code: string; message: string }, retryable: boolean) {
  return transaction(async client => {
    const row = await lockAttempt(client, attemptId);
    if (!row || row.status !== "submitting") return null;
    await client.query("UPDATE delivery_attempts SET status='failed',outcome_determinate=true,error_category=$2,error_code=$3,error_message=$4,finished_at=now(),reconcile_after=NULL WHERE id=$1", [attemptId, error.category, error.code, error.message]);
    const targetId = ((row.routing_snapshot.chosen ?? {}) as Record<string, unknown>).targetId;
    const threshold = positiveInteger(process.env.ENVOY_CIRCUIT_FAILURE_THRESHOLD, 5);
    if (retryable && typeof targetId === "string" && ["network", "provider", "rate_limit"].includes(error.category)) {
      const recent = await client.query<{ sample_count: string; all_failed: boolean }>("SELECT count(*)::text AS sample_count,COALESCE(bool_and(status='failed' AND error_category=ANY($2::text[])),false) AS all_failed FROM (SELECT status,error_category FROM delivery_attempts WHERE routing_snapshot#>>'{chosen,targetId}'=$1 ORDER BY started_at DESC LIMIT $3) samples", [targetId, ["network", "provider", "rate_limit"], threshold]);
      if (Number(recent.rows[0]?.sample_count) === threshold && recent.rows[0]?.all_failed) await client.query("UPDATE routing_targets SET status='circuit_open',circuit_open_until=now()+$2*interval '1 second',updated_at=now() WHERE id=$1", [targetId, positiveInteger(process.env.ENVOY_CIRCUIT_OPEN_SECONDS, 300)]);
    }
    if (error.category === "invalid_recipient") await client.query("INSERT INTO suppressions(id,scope_type,email_normalized,reason,source) SELECT $1,'global',recipient_email,'invalid_recipient','provider_rejection' FROM deliveries WHERE id=$2 ON CONFLICT DO NOTHING", [createId("sup"), row.delivery_id]);
    const retry = row.is_current && retryable && row.attempt_number < 5;
    await applyDeliveryEvent(client, row.delivery_id, { id: attemptId, type: retry ? "deferred" : "failed", occurredAt: new Date(), metadata: { ...error, source: "provider_submission" } }, `attempt:${attemptId}:failure`, { attemptId });
    if (retry) await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'delivery',$2,'delivery.requested',$3,now()+interval '5 seconds')", [createId("out"), row.delivery_id, { deliveryId: row.delivery_id }]);
    return row.delivery_id;
  });
}

export async function getAttemptForReconciliation(attemptId: string) {
  // Claim due reconciliation work; a duplicate consumer cannot spend another attempt concurrently.
  return (await query<{
    id: string; delivery_id: string; provider_account_id: string; external_message_id: string | null; request_fingerprint: string; status: string
  }>(`UPDATE delivery_attempts a SET reconciliation_count=reconciliation_count+1,reconcile_after=now()+interval '2 minutes'
    FROM deliveries d WHERE a.id=$1 AND d.current_attempt_id=a.id AND a.status IN ('unknown','reconciling')
      AND a.retry_authorized_at IS NULL AND a.reconcile_after<=now() AND a.reconciliation_count<12
    RETURNING a.id,a.delivery_id,a.provider_account_id,a.external_message_id,a.request_fingerprint,a.status`, [attemptId])).rows[0] ?? null;
}

export async function markReconciled(attemptId: string, outcome: "accepted" | "not_accepted" | "unknown") {
  await transaction(async client => {
    const row = await lockAttempt(client, attemptId);
    if (!row || !["unknown", "reconciling"].includes(row.status)) return;
    if (outcome === "unknown") {
      if (row.retry_authorized_at) return;
      const exhausted = row.reconciliation_count >= 12;
      await client.query("UPDATE delivery_attempts SET status=$2,reconcile_after=CASE WHEN $3 THEN NULL ELSE now()+interval '5 minutes' END,error_code=CASE WHEN $3 THEN 'reconciliation_exhausted' ELSE error_code END WHERE id=$1", [attemptId, exhausted ? "unknown" : "reconciling", exhausted]);
      if (!exhausted && row.is_current) await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'attempt',$2,'delivery.reconcile',$3,now()+interval '5 minutes')", [createId("out"), attemptId, { attemptId }]);
      return;
    }
    await client.query("UPDATE delivery_attempts SET status=$2,outcome_determinate=true,finished_at=now(),reconcile_after=NULL WHERE id=$1", [attemptId, outcome === "accepted" ? "reconciled" : "failed"]);
    const retry = outcome === "not_accepted" && row.is_current && !row.retry_authorized_at && row.attempt_number < 5;
    await applyDeliveryEvent(client, row.delivery_id, { id: attemptId, type: outcome === "accepted" ? "accepted" : retry ? "deferred" : "failed", occurredAt: outcome === "accepted" ? row.started_at : new Date(), metadata: { source: "reconciliation" } }, `attempt:${attemptId}:reconciled:${outcome}`, { attemptId, projectLifecycle: outcome === "accepted" || !row.retry_authorized_at });
    if (retry) await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'delivery',$2,'delivery.requested',$3,now()+interval '5 seconds')", [createId("out"), row.delivery_id, { deliveryId: row.delivery_id }]);
  });
}

export { getDeliveryRetryEligibility as getRetryEligibility, retryDelivery } from "@/modules/core/message/service";
