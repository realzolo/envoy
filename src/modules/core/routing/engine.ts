import { createHash } from "node:crypto";
import { query, transaction } from "@/server/database";
import { createId } from "@/server/ids";
import { enforceScopedRateLimit } from "@/server/redis";

type Candidate = {
  target_id: string;
  policy_id: string;
  policy_name: string;
  policy_priority: number;
  provider_account_id: string;
  provider_identity_id: string;
  provider_type: string;
  provider_name: string;
  priority: number;
  weight: number;
  rate_limit_per_minute: number;
  domain: string;
  capabilities: Record<string, unknown>;
  quota: Record<string, unknown>;
  monthly_usage: string;
  daily_usage: string
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
  subjectTemplate: string;
  htmlTemplate: string;
  textTemplate: string;
  variables: Record<string, unknown>;
  product: string;
  templateKey: string
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

export function selectEligibleTarget<T extends {
  priority: number;
  weight: number;
  targetStatus: string;
  accountStatus: string;
  identityStatus: string;
  healthy: boolean;
  quotaAvailable: boolean;
  circuitOpen: boolean
}>(seed: string, attempt: number, candidates: T[]) {
  return chooseWeighted(seed, attempt, candidates.filter(candidate => candidate.targetStatus === "active" && candidate.accountStatus === "active" && candidate.identityStatus === "verified" && candidate.healthy && candidate.quotaAvailable && !candidate.circuitOpen))
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
    FROM delivery_attempts WHERE provider_account_id=$1 AND status IN ('submitting','accepted','reconciled')`, [candidate.provider_account_id]);
  const row = usage.rows[0];
  return (monthlyLimit === undefined || Number(row.monthly) < monthlyLimit) && (dailyLimit === undefined || Number(row.daily) < dailyLimit);
}

async function deferDelivery(client: import("pg").PoolClient, deliveryId: string, reason: string) {
  await client.query("UPDATE deliveries SET lifecycle_status='deferred',updated_at=now() WHERE id=$1", [deliveryId]);
  await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'delivery',$2,'delivery.requested',$3,now()+interval '1 minute')", [createId("out"), deliveryId, {
    deliveryId,
    reason
  }])
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
      template_id: string;
      sender_profile_id: string;
      category: string;
      product: string;
      template_key: string;
      variables: Record<string, unknown>;
      subject_template: string;
      html_template: string;
      text_template: string;
      from_name: string;
      from_local_part: string;
      reply_to: string | null;
      sending_domain_id: string
    }>(`SELECT d.id,d.message_id,d.recipient_email,d.recipient_name,d.lifecycle_status,m.product_id,m.service_id,m.template_id,m.sender_profile_id,
      t.category,p.name AS product,t.key AS template_key,m.variables,tv.subject_template,tv.html_template,tv.text_template,
      sp.from_name,sp.from_local_part,sp.reply_to,sp.sending_domain_id
      FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN products p ON p.id=m.product_id
      JOIN templates t ON t.id=m.template_id JOIN template_versions tv ON tv.id=m.template_version_id
      JOIN sender_profiles sp ON sp.id=m.sender_profile_id WHERE d.id=$1 FOR UPDATE OF d`, [deliveryId]);
    const delivery = deliveryResult.rows[0];
    if (!delivery) return null;
    const last = await client.query<{
      id: string;
      status: string;
      outcome_determinate: boolean;
      external_message_id: string | null;
      attempt_number: number
    }>("SELECT id,status,outcome_determinate,external_message_id,attempt_number FROM delivery_attempts WHERE delivery_id=$1 ORDER BY attempt_number DESC LIMIT 1", [deliveryId]);
    if (last.rows[0]?.status === "submitting") {
      await client.query("UPDATE delivery_attempts SET status='unknown',outcome_determinate=false,error_category='unknown',error_code='interrupted_submission',error_message='Submission ownership was interrupted',finished_at=now() WHERE id=$1", [last.rows[0].id]);
      await client.query("UPDATE deliveries SET lifecycle_status='unknown',updated_at=now() WHERE id=$1", [deliveryId]);
      await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'attempt',$2,'delivery.reconcile',$3,now()+interval '30 seconds')", [createId("out"), last.rows[0].id, { attemptId: last.rows[0].id }]);
      return { reconcileAttemptId: last.rows[0].id }
    }
    if (last.rows[0]?.status === "unknown" || last.rows[0]?.status === "reconciling") return { reconcileAttemptId: last.rows[0].id };
    if ((last.rows[0]?.status === "accepted" || last.rows[0]?.status === "reconciled" || delivery.lifecycle_status === "delivered") && delivery.lifecycle_status !== "queued") return null;
    if (delivery.lifecycle_status !== "queued" && delivery.lifecycle_status !== "deferred" && delivery.lifecycle_status !== "failed") return null;
    const prior = await client.query<{
      provider_account_id: string
    }>("SELECT provider_account_id FROM delivery_attempts WHERE delivery_id=$1 AND outcome_determinate=true AND status='failed' AND NOT (routing_snapshot?'manualRetryAuthorizedAt')", [deliveryId]);
    const excluded = prior.rows.map(r => r.provider_account_id);
    const candidates = await client.query<Candidate>(`SELECT rt.id AS target_id,rp.id AS policy_id,rp.name AS policy_name,rp.priority AS policy_priority,rt.provider_account_id,rt.provider_identity_id,
      pa.type AS provider_type,pa.name AS provider_name,rt.priority,rt.weight,rt.rate_limit_per_minute,sd.domain,pi.capabilities,pa.quota,
      usage.monthly_usage::text,usage.daily_usage::text
      FROM routing_policies rp JOIN routing_targets rt ON rt.policy_id=rp.id
      JOIN provider_accounts pa ON pa.id=rt.provider_account_id JOIN provider_identities pi ON pi.id=rt.provider_identity_id
      JOIN sending_domains sd ON sd.id=pi.sending_domain_id
      CROSS JOIN LATERAL (SELECT
        count(*) FILTER (WHERE da.started_at>=date_trunc('month',now()) AND da.status IN ('submitting','accepted','reconciled')) AS monthly_usage,
        count(*) FILTER (WHERE da.started_at>=date_trunc('day',now()) AND da.status IN ('submitting','accepted','reconciled')) AS daily_usage
        FROM delivery_attempts da WHERE da.provider_account_id=pa.id) usage
      WHERE rp.status='active' AND (rt.status='active' OR (rt.status='circuit_open' AND rt.circuit_open_until<=now()))
        AND pa.status='active' AND COALESCE(pa.health->>'status','unknown') NOT IN ('unhealthy','offline')
        AND pi.status='verified' AND pi.sending_domain_id=$1 AND pi.provider_account_id=pa.id AND sd.status='active'
        AND (NOT (pa.quota?'monthlyLimit') OR ((pa.quota->>'monthlyLimit')~'^[0-9]+$' AND usage.monthly_usage<(pa.quota->>'monthlyLimit')::bigint))
        AND (NOT (pa.quota?'dailyLimit') OR ((pa.quota->>'dailyLimit')~'^[0-9]+$' AND usage.daily_usage<(pa.quota->>'dailyLimit')::bigint))
        AND (rp.product_id IS NULL OR rp.product_id=$2) AND (rp.service_id IS NULL OR rp.service_id=$3)
        AND (rp.template_id IS NULL OR rp.template_id=$4) AND (rp.message_category IS NULL OR rp.message_category=$5)
        AND (rp.destination_region IS NULL OR rp.destination_region=sd.region)
        AND (cardinality($6::text[])=0 OR NOT (rt.provider_account_id=ANY($6::text[])))
      ORDER BY rp.priority,rt.priority,rt.id`, [delivery.sending_domain_id, delivery.product_id, delivery.service_id, delivery.template_id, delivery.category, excluded]);
    if (!candidates.rows.length) {
      await deferDelivery(client, deliveryId, "No healthy verified routing target is available");
      return null
    }
    const attemptNumber = (last.rows[0]?.attempt_number ?? 0) + 1;
    let pool = candidates.rows;
    let selected: Candidate | undefined;
    while (pool.length) {
      const pick = choosePolicyTarget(deliveryId, attemptNumber, pool.map(candidate => ({
        ...candidate,
        policyPriority: candidate.policy_priority
      })));
      if (!pick) break;
      if (await reserveProviderCapacity(client, pick) && await enforceScopedRateLimit("provider", pick.provider_account_id, pick.rate_limit_per_minute) && await enforceScopedRateLimit("identity", pick.provider_identity_id, pick.rate_limit_per_minute)) {
        selected = pick;
        break
      }
      pool = pool.filter(c => c.target_id !== pick.target_id)
    }
    if (!selected) {
      await deferDelivery(client, deliveryId, "All routing targets are quota exhausted or rate limited");
      return null
    }
    const attemptId = createId("att");
    const providerIdempotencyKey = selected.capabilities.nativeIdempotency === true ? `envoy/${deliveryId}/${attemptNumber}` : null;
    const fingerprint = createHash("sha256").update(JSON.stringify({
      deliveryId,
      attemptNumber,
      to: delivery.recipient_email,
      template: delivery.template_key,
      variables: delivery.variables,
      from: `${delivery.from_local_part}@${selected.domain}`
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
        nativeIdempotency: selected.capabilities.nativeIdempotency === true
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
    await client.query("UPDATE deliveries SET lifecycle_status='submitting',current_attempt_id=$2,updated_at=now() WHERE id=$1", [deliveryId, attemptId]);
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
      fromEmail: `${delivery.from_local_part}@${selected.domain}`,
      replyTo: delivery.reply_to,
      subjectTemplate: delivery.subject_template,
      htmlTemplate: delivery.html_template,
      textTemplate: delivery.text_template,
      variables: delivery.variables,
      product: delivery.product,
      templateKey: delivery.template_key
    };
  });
}

export async function markAccepted(attemptId: string, externalMessageId: string, response: Record<string, unknown> = {}) {
  await transaction(async client => {
    const row = await client.query<{
      delivery_id: string;
      routing_snapshot: Record<string, unknown>
    }>(`UPDATE delivery_attempts SET status='accepted',outcome_determinate=true,external_message_id=$2,provider_response_ref=$3,finished_at=now() WHERE id=$1 RETURNING delivery_id,routing_snapshot`, [attemptId, externalMessageId, JSON.stringify(response)]);
    if (row.rows[0]) {
      await client.query("UPDATE deliveries SET lifecycle_status='accepted',accepted_at=now(),updated_at=now() WHERE id=$1", [row.rows[0].delivery_id]);
      const targetId = ((row.rows[0].routing_snapshot.chosen ?? {}) as Record<string, unknown>).targetId;
      if (typeof targetId === "string") await client.query("UPDATE routing_targets SET status='active',circuit_open_until=NULL,updated_at=now() WHERE id=$1", [targetId])
    }
  })
}

export async function markUnknown(attemptId: string, message: string) {
  await transaction(async client => {
    const row = await client.query<{
      delivery_id: string
    }>("UPDATE delivery_attempts SET status='unknown',outcome_determinate=false,error_category='unknown',error_message=$2,finished_at=now() WHERE id=$1 RETURNING delivery_id", [attemptId, message]);
    if (row.rows[0]) {
      await client.query("UPDATE deliveries SET lifecycle_status='unknown',updated_at=now() WHERE id=$1", [row.rows[0].delivery_id]);
      await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'attempt',$2,'delivery.reconcile',$3,now()+interval '30 seconds')", [createId("out"), attemptId, { attemptId }])
    }
  })
}

export async function markDeterminateFailure(attemptId: string, error: {
  category: string;
  code: string;
  message: string
}, retryable: boolean) {
  return transaction(async client => {
    const row = await client.query<{
      delivery_id: string;
      attempt_number: number;
      routing_snapshot: Record<string, unknown>
    }>("UPDATE delivery_attempts SET status='failed',outcome_determinate=true,error_category=$2,error_code=$3,error_message=$4,finished_at=now() WHERE id=$1 RETURNING delivery_id,attempt_number,routing_snapshot", [attemptId, error.category, error.code, error.message]);
    if (!row.rows[0]) return null;
    const targetId = ((row.rows[0].routing_snapshot.chosen ?? {}) as Record<string, unknown>).targetId;
    const threshold = positiveInteger(process.env.ENVOY_CIRCUIT_FAILURE_THRESHOLD, 5);
    if (retryable && typeof targetId === "string" && ["network", "provider", "rate_limit"].includes(error.category)) {
      const recent = await client.query<{
        sample_count: string;
        all_failed: boolean
      }>(`SELECT count(*)::text AS sample_count,COALESCE(bool_and(status='failed' AND error_category=ANY($2::text[])),false) AS all_failed FROM (SELECT status,error_category FROM delivery_attempts WHERE routing_snapshot#>>'{chosen,targetId}'=$1 ORDER BY started_at DESC LIMIT $3) samples`, [targetId, ["network", "provider", "rate_limit"], threshold]);
      if (Number(recent.rows[0]?.sample_count) === threshold && recent.rows[0]?.all_failed) {
        const seconds = positiveInteger(process.env.ENVOY_CIRCUIT_OPEN_SECONDS, 300);
        await client.query("UPDATE routing_targets SET status='circuit_open',circuit_open_until=now()+$2*interval '1 second',updated_at=now() WHERE id=$1", [targetId, seconds])
      }
    }
    const retry = retryable && row.rows[0].attempt_number < 5;
    await client.query("UPDATE deliveries SET lifecycle_status=$2,updated_at=now() WHERE id=$1", [row.rows[0].delivery_id, retry ? "queued" : "failed"]);
    if (error.category === "invalid_recipient") {
      const delivery = (await client.query<{
        recipient_email: string
      }>("SELECT recipient_email FROM deliveries WHERE id=$1", [row.rows[0].delivery_id])).rows[0];
      if (delivery) await client.query("INSERT INTO suppressions(id,scope_type,email_normalized,reason,source) VALUES ($1,'global',$2,'invalid_recipient','provider_rejection') ON CONFLICT DO NOTHING", [createId("sup"), delivery.recipient_email])
    }
    if (retry) await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'delivery',$2,'delivery.requested',$3,now()+interval '5 seconds')", [createId("out"), row.rows[0].delivery_id, { deliveryId: row.rows[0].delivery_id }]);
    return row.rows[0].delivery_id
  })
}

export async function getAttemptForReconciliation(attemptId: string) {
  return (await query<{
    id: string;
    delivery_id: string;
    provider_account_id: string;
    external_message_id: string | null;
    request_fingerprint: string;
    status: string
  }>("SELECT id,delivery_id,provider_account_id,external_message_id,request_fingerprint,status FROM delivery_attempts WHERE id=$1", [attemptId])).rows[0] ?? null
}

export async function markReconciled(attemptId: string, outcome: "accepted" | "not_accepted" | "unknown") {
  await transaction(async client => {
    const row = await client.query<{
      delivery_id: string
    }>("UPDATE delivery_attempts SET status=$2,outcome_determinate=$3,finished_at=CASE WHEN $2<>'reconciling' THEN now() ELSE finished_at END WHERE id=$1 RETURNING delivery_id", [attemptId, outcome === "accepted" ? "reconciled" : outcome === "not_accepted" ? "failed" : "reconciling", outcome !== "unknown"]);
    if (!row.rows[0]) return;
    if (outcome === "accepted") await client.query("UPDATE deliveries SET lifecycle_status='accepted',updated_at=now() WHERE id=$1", [row.rows[0].delivery_id]); else if (outcome === "not_accepted") {
      await client.query("UPDATE deliveries SET lifecycle_status='queued',updated_at=now() WHERE id=$1", [row.rows[0].delivery_id]);
      await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'delivery',$2,'delivery.requested',$3)", [createId("out"), row.rows[0].delivery_id, { deliveryId: row.rows[0].delivery_id }])
    } else await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'attempt',$2,'delivery.reconcile',$3,now()+interval '5 minutes')", [createId("out"), attemptId, { attemptId }])
  })
}
