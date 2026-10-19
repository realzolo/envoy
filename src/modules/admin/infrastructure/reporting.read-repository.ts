import type { AuditEntryDto,FailedWorkDto } from '@/modules/admin/contracts';
import { query } from '@/platform/database';
export const reportingReads={failedWork: () => query<FailedWorkDto>("SELECT id,aggregate_type,aggregate_id,event_type,status,attempt_count,available_at,created_at FROM outbox_events WHERE status='failed' OR (status='pending' AND available_at<now()-interval '1 minute') ORDER BY available_at LIMIT 200"),
audit: () => query<AuditEntryDto>("SELECT id,actor,action,resource_type,resource_id,details,created_at FROM audit_logs ORDER BY created_at DESC LIMIT 300")};

import { effectiveDomainGrants } from '@/modules/identity/infrastructure/authorization';
import { listEmails } from '@/modules/outbound/public';
import { workerHeartbeatAlive } from '@/platform/runtime-store';
export async function dashboardData() {
  const [counts, recent, trend, health, chains, workerAlive] = await Promise.all([
    query<{ accepted: string; delivered: string; bounced: string; failed: string; pending: string }>(`SELECT count(DISTINCT m.id) AS accepted,
      count(*) FILTER(WHERE d.lifecycle_status='delivered') AS delivered,
      count(*) FILTER(WHERE d.lifecycle_status='bounced') AS bounced,
      count(*) FILTER(WHERE d.lifecycle_status='failed' AND d.compliance_status<>'suppressed') AS failed,
      count(*) FILTER(WHERE d.lifecycle_status IN ('queued','submitting','accepted','deferred','unknown') AND d.compliance_status<>'suppressed') AS pending
      FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE m.accepted_at >= (((now() AT TIME ZONE 'UTC')::date - 6)::timestamp AT TIME ZONE 'UTC')`),
    listEmails(5),
    query<{ day: string; sent: string; delivered: string }>(`WITH days AS (SELECT generate_series((now() AT TIME ZONE 'UTC')::date - 6,(now() AT TIME ZONE 'UTC')::date,interval '1 day')::date AS day)
      SELECT days.day::text,count(d.id) AS sent,count(d.id) FILTER(WHERE d.lifecycle_status='delivered') AS delivered
      FROM days LEFT JOIN deliveries d ON (d.queued_at AT TIME ZONE 'UTC')::date=days.day GROUP BY days.day ORDER BY days.day`),
    query<{ outbox: string; outbox_failed: string; oldest_due_seconds: string; dead_letters: string; unknown: string; raw_errors: string }>(`SELECT
      (SELECT count(*) FROM outbox_events WHERE status='pending' AND available_at<now()-interval '1 minute') AS outbox,
      (SELECT count(*) FROM outbox_events WHERE status='failed') AS outbox_failed,
      (SELECT coalesce(extract(epoch FROM now()-min(available_at)),0) FROM outbox_events WHERE status='pending' AND available_at<=now()) AS oldest_due_seconds,
      (SELECT count(*) FROM callback_deliveries WHERE status='dead_letter') AS dead_letters,
      (SELECT count(*) FROM deliveries WHERE lifecycle_status='unknown') AS unknown,
      (SELECT count(*) FROM raw_provider_events WHERE processed_at IS NULL AND terminated_at IS NULL AND processing_error IS NOT NULL) AS raw_errors`),
    query<{id:string;service:string;category:string;sender:string;grant:boolean;credential:boolean;provider:boolean;identity:boolean;route:boolean;tested:boolean;observable:boolean;event_seen:boolean}>(`SELECT s.id||':'||sd.id||':'||cat.category AS id,s.name AS service,cat.category AS category,
      '*'||'@'||sd.domain AS sender,sg.status='active' AND sg.send_allowed AS grant,
      EXISTS(SELECT 1 FROM service_credentials c WHERE c.service_id=s.id AND c.status='active' AND c.valid_from<=now() AND (c.valid_to IS NULL OR c.valid_to>now())) AS credential,
      EXISTS(SELECT 1 FROM provider_identities pi JOIN provider_accounts pa ON pa.id=pi.provider_account_id WHERE pi.sending_domain_id=sd.id AND pa.status='active') AS provider,
      EXISTS(SELECT 1 FROM provider_identities pi JOIN provider_accounts pa ON pa.id=pi.provider_account_id WHERE pi.sending_domain_id=sd.id AND pi.status='verified' AND pa.status='active') AS identity,
      EXISTS(SELECT 1 FROM routing_policies rp JOIN routing_targets rt ON rt.policy_id=rp.id JOIN provider_identities pi ON pi.id=rt.provider_identity_id JOIN provider_accounts pa ON pa.id=rt.provider_account_id
        WHERE rp.status='active' AND rp.sending_domain_id=sd.id AND (rp.service_scope='all' OR EXISTS(SELECT 1 FROM routing_policy_services rs WHERE rs.policy_id=rp.id AND rs.service_id=s.id)) AND (rp.message_category IS NULL OR rp.message_category=cat.category)
        AND pi.sending_domain_id=sd.id AND pi.status='verified' AND pa.status='active' AND (rt.status='active' OR rt.circuit_open_until<=now())) AS route,
      EXISTS(SELECT 1 FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE m.service_id=s.id AND m.sending_domain_id=sd.id AND m.message_category=cat.category AND d.lifecycle_status IN ('accepted','delivered')) AS tested,
      EXISTS(SELECT 1 FROM routing_policies rp JOIN routing_targets rt ON rt.policy_id=rp.id JOIN provider_identities pi ON pi.id=rt.provider_identity_id JOIN provider_accounts pa ON pa.id=rt.provider_account_id JOIN provider_webhook_endpoints we ON we.provider_account_id=pa.id
        WHERE rp.status='active' AND rp.sending_domain_id=sd.id AND (rp.service_scope='all' OR EXISTS(SELECT 1 FROM routing_policy_services rs WHERE rs.policy_id=rp.id AND rs.service_id=s.id)) AND (rp.message_category IS NULL OR rp.message_category=cat.category)
        AND pi.status='verified' AND pa.status='active' AND rt.status='active' AND we.status='active' AND we.security_configured) AS observable,
      EXISTS(SELECT 1 FROM messages m JOIN deliveries d ON d.message_id=m.id JOIN delivery_events e ON e.delivery_id=d.id WHERE m.service_id=s.id AND m.sending_domain_id=sd.id AND m.message_category=cat.category AND e.raw_provider_event_id IS NOT NULL) AS event_seen
      FROM services s CROSS JOIN sending_domains sd
      JOIN LATERAL (${effectiveDomainGrants("s.id", "sd.id")}) sg ON true
      CROSS JOIN LATERAL (SELECT 'transactional'::text AS category UNION SELECT rp.message_category FROM routing_policies rp WHERE rp.sending_domain_id=sd.id AND (rp.service_scope='all' OR EXISTS(SELECT 1 FROM routing_policy_services rs WHERE rs.policy_id=rp.id AND rs.service_id=s.id)) AND rp.message_category IS NOT NULL) cat
      WHERE s.status='active' AND sd.status='active' ORDER BY s.name,sd.domain LIMIT 100`),
    workerHeartbeatAlive()
  ]);
  const c = counts.rows[0];
  const completed = Number(c.delivered)+Number(c.bounced)+Number(c.failed);
  const h = health.rows[0];
  return {
    stats: { windowStart: trend.rows[0] ? `${trend.rows[0].day}T00:00:00.000Z` : new Date().toISOString(), windowEnd:new Date().toISOString(), accepted:Number(c.accepted),delivered:Number(c.delivered),bounced:Number(c.bounced),pending:Number(c.pending),deliveryRate:completed ? Number(c.delivered)/completed*100 : 0,bounceRate:completed ? Number(c.bounced)/completed*100 : 0 },
    recent,
    trend:trend.rows.map(row=>({label:`${row.day}T00:00:00.000Z`,sent:Number(row.sent),delivered:Number(row.delivered)})),
    health:{outbox:Number(h.outbox),outboxFailed:Number(h.outbox_failed),oldestDueSeconds:Number(h.oldest_due_seconds),deadLetters:Number(h.dead_letters),unknown:Number(h.unknown),rawErrors:Number(h.raw_errors),workerAlive},
    setup: { chains: chains.rows }
  }
}

