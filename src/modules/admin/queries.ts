import { scanPolicy } from "@/modules/attachments/scanner";
import type { MessageFilters } from "@/modules/admin/message-filters";
import { getRetryEligibility } from "@/modules/core/routing/engine";
import type { DeliveryStatus, EmailRecord } from "@/lib/types";
import { providerDescriptors } from "@/modules/providers/registry";
import { query } from "@/server/database";
import { workerHeartbeatAlive } from "@/server/runtime-store";
import { effectiveDomainGrants } from "@/modules/core/resources/authorization";

type EmailRow = {
  delivery_id: string; message_id: string; recipient_email: string; recipient_name: string | null; recipient_role: "to" | "cc" | "bcc"; last_error: Record<string, unknown> | null;
  lifecycle_status: string; compliance_status: string; engagement_status: string;
  accepted_at: Date; cursor_at: string; updated_at: Date; reference_id: string | null; subject: string; category: string;
  product_name: string; sender_snapshot: { fromName?: string; fromEmail: string };
  external_message_id: string | null; current_attempt_id: string | null;
};
const emailSelect = `SELECT d.id AS delivery_id,d.recipient_email,d.recipient_name,d.recipient_role,d.last_error,d.lifecycle_status,d.compliance_status,d.engagement_status,d.message_id,d.current_attempt_id,d.updated_at,m.accepted_at,to_char(m.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,m.reference_id,m.subject,m.message_category AS category,m.sender_snapshot,p.name AS product_name,da.external_message_id FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN products p ON p.id=m.product_id LEFT JOIN submission_attempts da ON da.id=d.current_attempt_id`;

function mapEmail(row: EmailRow): EmailRecord {
  return {
    id: row.delivery_id, messageId: row.message_id, recipient: row.recipient_email,
    recipientName: row.recipient_name ?? undefined, recipientRole: row.recipient_role, lastError: row.last_error, subject: row.subject, category: row.category,
    product: row.product_name, from: row.sender_snapshot.fromName ? `${row.sender_snapshot.fromName} <${row.sender_snapshot.fromEmail}>` : row.sender_snapshot.fromEmail,
    status: (row.compliance_status === "suppressed" ? "suppressed" : row.lifecycle_status) as DeliveryStatus,
    createdAt: row.accepted_at.toISOString(), relativeTime: row.accepted_at.toISOString(),
    providerId: row.external_message_id ?? undefined, referenceId: row.reference_id ?? undefined
  }
}

export async function listEmailPage(filters: MessageFilters, limit = 20) {
  const values: unknown[] = [];
  const conditions: string[] = [];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}` };
  if (filters.q) {
    const key = bind(`%${filters.q.replace(/[\\%_]/g, "\\$&")}%`);
    conditions.push(`(d.id ILIKE ${key} OR m.id ILIKE ${key} OR m.reference_id ILIKE ${key} OR d.recipient_email ILIKE ${key} OR m.subject ILIKE ${key} OR p.name ILIKE ${key})`)
  }
  if (filters.status === "suppressed") conditions.push("d.compliance_status='suppressed'");
  else if (filters.status !== "all") conditions.push(`d.lifecycle_status=${bind(filters.status)} AND d.compliance_status<>'suppressed'`);
  if (filters.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(filters.cursor, "base64url").toString("utf8"));
      if (typeof cursor.at === "string" && Number.isFinite(Date.parse(cursor.at)) && typeof cursor.id === "string") {
        conditions.push(`(m.accepted_at,d.id)<(${bind(cursor.at)}::timestamptz,${bind(cursor.id)})`)
      }
    } catch { /* An invalid bookmark starts at the first page. */ }
  }
  const pageSize = Math.max(1, Math.min(10000, limit));
  const result = await query<EmailRow>(`${emailSelect} ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY m.accepted_at DESC,d.id DESC LIMIT ${bind(pageSize + 1)}`, values);
  const selected = result.rows.slice(0, pageSize);
  const last = selected.at(-1);
  return {
    records: selected.map(mapEmail),
    nextCursor: result.rows.length > pageSize && last ? Buffer.from(JSON.stringify({at:last.cursor_at,id:last.delivery_id})).toString("base64url") : null
  }
}

export async function listEmails(limit = 200) {
  return (await listEmailPage({ q: "", status: "all" }, limit)).records
}

export async function getDeliveryDetail(id: string) {
  const row = (await query<EmailRow>(`${emailSelect} WHERE d.id=$1`, [id])).rows[0];
  if (!row) return null;
  const [attempts, events, content, eligibility] = await Promise.all([
    query(`SELECT da.id,da.submission_id,da.attempt_number,da.status,da.outcome_determinate,da.external_message_id,da.error_category,da.error_code,da.error_message,da.diagnostic,da.routing_snapshot,da.started_at,da.finished_at,da.retry_authorized_at,da.retry_authorized_by,da.reconciliation_count,da.reconcile_after,pa.name AS provider_account,pa.type AS provider_type FROM submission_attempts da JOIN submission_deliveries sd ON sd.submission_id=da.submission_id JOIN provider_accounts pa ON pa.id=da.provider_account_id WHERE sd.delivery_id=$1 ORDER BY da.attempt_number DESC`, [id]),
    query(`SELECT id,event_type,occurred_at,canonical_payload,scope FROM (
      SELECT id,event_type,occurred_at,canonical_payload,'recipient' AS scope FROM delivery_events WHERE delivery_id=$1
      UNION ALL SELECT e.id,e.event_type,e.occurred_at,e.canonical_payload,'submission' AS scope FROM submission_events e JOIN submission_deliveries sd ON sd.submission_id=e.submission_id WHERE sd.delivery_id=$1
    ) events ORDER BY occurred_at DESC,id DESC`, [id]),
    query<{ content_policy:string;html_body:string|null;text_body:string|null;reply_to:Array<{email:string;name?:string}>;to_recipients:Array<{email:string;name?:string}>;cc_recipients:Array<{email:string;name?:string}>;bcc_recipients:Array<{email:string;name?:string}>;attachment_snapshot:Array<Record<string,unknown>>;headers:Record<string,string>;in_reply_to:string|null;references_ids:string[];sender_snapshot:EmailRow["sender_snapshot"];content_purged_at:string|null }>(`SELECT content_policy,html_body,text_body,reply_to,to_recipients,cc_recipients,bcc_recipients,attachment_snapshot,headers,in_reply_to,references_ids,sender_snapshot,content_purged_at FROM messages WHERE id=$1`, [row.message_id]),
    getRetryEligibility(id)
  ]);
  return {
    ...mapEmail(row), lifecycle: row.lifecycle_status, engagement: row.engagement_status,
    compliance: row.compliance_status, updatedAt: row.updated_at.toISOString(),
    currentAttemptId: row.current_attempt_id, attempts: attempts.rows, events: events.rows,
    content: content.rows[0], retry: eligibility
  }
}

export async function messageComposerData() {
  const services = await query<{ id: string; name: string; product: string; product_id: string }>(`SELECT s.id,s.name,p.name AS product,p.id AS product_id
    FROM services s JOIN products p ON p.id=s.product_id
    WHERE p.status='active'
    ORDER BY p.name,s.name`);
  return { services: services.rows };
}

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
    query<{id:string;product:string;service:string;category:string;sender:string;grant:boolean;credential:boolean;provider:boolean;identity:boolean;route:boolean;tested:boolean;observable:boolean;event_seen:boolean}>(`SELECT s.id||':'||sd.id||':'||cat.category AS id,p.name AS product,s.name AS service,cat.category AS category,
      '*'||'@'||sd.domain AS sender,sg.status='active' AND sg.send_allowed AS grant,
      EXISTS(SELECT 1 FROM service_credentials c WHERE c.service_id=s.id AND c.status='active' AND c.valid_from<=now() AND (c.valid_to IS NULL OR c.valid_to>now())) AS credential,
      EXISTS(SELECT 1 FROM provider_identities pi JOIN provider_accounts pa ON pa.id=pi.provider_account_id WHERE pi.sending_domain_id=sd.id AND pa.status='active') AS provider,
      EXISTS(SELECT 1 FROM provider_identities pi JOIN provider_accounts pa ON pa.id=pi.provider_account_id WHERE pi.sending_domain_id=sd.id AND pi.status='verified' AND pa.status='active') AS identity,
      EXISTS(SELECT 1 FROM routing_policies rp JOIN routing_targets rt ON rt.policy_id=rp.id JOIN provider_identities pi ON pi.id=rt.provider_identity_id JOIN provider_accounts pa ON pa.id=rt.provider_account_id
        WHERE rp.status='active' AND rp.sending_domain_id=sd.id AND (rp.product_id IS NULL OR rp.product_id=p.id) AND (rp.service_id IS NULL OR rp.service_id=s.id) AND (rp.message_category IS NULL OR rp.message_category=cat.category)
        AND pi.sending_domain_id=sd.id AND pi.status='verified' AND pa.status='active' AND (rt.status='active' OR rt.circuit_open_until<=now())) AS route,
      EXISTS(SELECT 1 FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE m.service_id=s.id AND m.sending_domain_id=sd.id AND m.message_category=cat.category AND d.lifecycle_status IN ('accepted','delivered')) AS tested,
      EXISTS(SELECT 1 FROM routing_policies rp JOIN routing_targets rt ON rt.policy_id=rp.id JOIN provider_identities pi ON pi.id=rt.provider_identity_id JOIN provider_accounts pa ON pa.id=rt.provider_account_id JOIN provider_webhook_endpoints we ON we.provider_account_id=pa.id
        WHERE rp.status='active' AND rp.sending_domain_id=sd.id AND (rp.product_id IS NULL OR rp.product_id=p.id) AND (rp.service_id IS NULL OR rp.service_id=s.id) AND (rp.message_category IS NULL OR rp.message_category=cat.category)
        AND pi.status='verified' AND pa.status='active' AND rt.status='active' AND we.status='active' AND we.security_configured) AS observable,
      EXISTS(SELECT 1 FROM messages m JOIN deliveries d ON d.message_id=m.id JOIN delivery_events e ON e.delivery_id=d.id WHERE m.service_id=s.id AND m.sending_domain_id=sd.id AND m.message_category=cat.category AND e.raw_provider_event_id IS NOT NULL) AS event_seen
      FROM services s JOIN products p ON p.id=s.product_id CROSS JOIN sending_domains sd
      JOIN LATERAL (${effectiveDomainGrants("s.id", "sd.id")}) sg ON true
      CROSS JOIN LATERAL (SELECT 'transactional'::text AS category UNION SELECT rp.message_category FROM routing_policies rp WHERE rp.sending_domain_id=sd.id AND (rp.product_id IS NULL OR rp.product_id=p.id) AND (rp.service_id IS NULL OR rp.service_id=s.id) AND rp.message_category IS NOT NULL) cat
      WHERE p.status='active' AND sd.status='active' ORDER BY p.name,s.name,sd.domain LIMIT 100`),
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

export type AdminSection =
  | "attachments"
  | "providers"
  | "domains"
  | "routing"
  | "api-keys"
  | "webhooks"
  | "events"
  | "suppressions"
  | "inbound"
  | "logs";

const adminQueries = {
  products: () => query("SELECT id,name,status FROM products ORDER BY name"),
  services: () => query("SELECT s.id,s.name,p.name AS product,p.id AS product_id,p.status AS product_status FROM services s JOIN products p ON p.id=s.product_id ORDER BY p.name,s.name"),
  providers: () => query(`SELECT a.id,a.type,a.name,a.status,a.public_config,
    coalesce(a.health->>'status','unknown') AS health,a.health AS health_details,a.quota,a.created_at,
    c.credential_version,e.id AS webhook_endpoint_id,e.opaque_token,e.status AS webhook_status,
    e.security_configured,e.expected_topic_arn,e.ip_allowlist,
    (SELECT max(r.received_at) FROM raw_provider_events r WHERE r.provider_account_id=a.id) AS last_event_at
    FROM provider_accounts a
    JOIN provider_credentials c ON c.provider_account_id=a.id AND c.status='active'
    JOIN provider_webhook_endpoints e ON e.provider_account_id=a.id
    ORDER BY a.name`),
  domains: () => query(`SELECT sd.id,sd.domain,sd.status,
    json_agg(json_build_object('id',pi.id,'accountId',pa.id,'account',pa.name,'type',pa.type,'accountStatus',pa.status,'status',pi.status,'externalId',pi.external_identity_id,'dnsRecords',pi.dns_records,'lastCheckedAt',pi.last_checked_at) ORDER BY pa.name)
      FILTER(WHERE pi.id IS NOT NULL) AS identities
    FROM sending_domains sd
    LEFT JOIN provider_identities pi ON pi.sending_domain_id=sd.id
    LEFT JOIN provider_accounts pa ON pa.id=pi.provider_account_id
    GROUP BY sd.id ORDER BY sd.domain`),
  grants:()=>query(`SELECT g.*,s.product_id,p.name AS product,s.name AS service,COALESCE(d.domain,'ALL (current and future domains)') AS domain FROM service_domain_grants g JOIN services s ON s.id=g.service_id JOIN products p ON p.id=s.product_id LEFT JOIN sending_domains d ON d.id=g.sending_domain_id ORDER BY p.name,s.name,d.domain NULLS FIRST`),
  policies: () => query(`SELECT rp.id,rp.name,rp.priority,rp.status,rp.product_id,rp.service_id,rp.sending_domain_id,p.name AS product,s.name AS service,sd_policy.domain AS sending_domain,rp.message_category,
    json_agg(json_build_object('id',rt.id,'accountId',pa.id,'account',pa.name,'type',pa.type,'identityId',pi.id,'domain',sd.domain,'priority',rt.priority,'weight',rt.weight,'rateLimit',rt.rate_limit_per_minute,'status',rt.status,'circuitOpenUntil',rt.circuit_open_until) ORDER BY rt.priority)
      FILTER(WHERE rt.id IS NOT NULL) AS targets
    FROM routing_policies rp
    LEFT JOIN products p ON p.id=rp.product_id
    LEFT JOIN services s ON s.id=rp.service_id
    JOIN sending_domains sd_policy ON sd_policy.id=rp.sending_domain_id
    LEFT JOIN routing_targets rt ON rt.policy_id=rp.id
    LEFT JOIN provider_accounts pa ON pa.id=rt.provider_account_id
    LEFT JOIN provider_identities pi ON pi.id=rt.provider_identity_id
    LEFT JOIN sending_domains sd ON sd.id=pi.sending_domain_id
    GROUP BY rp.id,p.name,s.name,sd_policy.domain ORDER BY rp.priority,rp.name`),
  credentials: () => query(`SELECT c.id,c.key_prefix,c.status,c.valid_from,c.valid_to,c.last_used_at,s.name AS service,s.id AS service_id,p.name AS product
    FROM service_credentials c JOIN services s ON s.id=c.service_id JOIN products p ON p.id=s.product_id ORDER BY c.created_at DESC`),
  webhooks: () => query(`SELECT e.id,e.opaque_token,e.status,e.security_configured,e.expected_topic_arn,e.ip_allowlist,e.created_at,pa.id AS provider_account_id,pa.name AS account,pa.type
    FROM provider_webhook_endpoints e JOIN provider_accounts pa ON pa.id=e.provider_account_id ORDER BY e.created_at DESC`),
  callbacks: () => query(`SELECT e.id,e.name,e.url,e.status,e.subscribed_events,s.id AS service_id,s.name AS service,p.name AS product,p.id AS product_id,
    count(d.id) FILTER(WHERE d.status='dead_letter') AS dead_letters,
    count(d.id) FILTER(WHERE d.status='delivering') AS in_flight
    FROM callback_endpoints e
    JOIN services s ON s.id=e.service_id
    JOIN products p ON p.id=s.product_id
    LEFT JOIN callback_deliveries d ON d.endpoint_id=e.id
    GROUP BY e.id,s.id,s.name,p.id,p.name ORDER BY e.created_at DESC`),
  callbackDeliveries: () => query(`SELECT d.id,d.endpoint_id,e.name AS endpoint,d.event_type,d.payload->>'id' AS event_id,d.payload_purged_at,d.status,d.attempt_count,d.next_attempt_at,d.response_code,d.last_error,d.delivered_at,d.created_at
    FROM callback_deliveries d JOIN callback_endpoints e ON e.id=d.endpoint_id ORDER BY d.created_at DESC LIMIT 200`),
  rawEvents: () => query(`SELECT r.id,r.native_type,r.provider_event_id,r.signature_valid,r.replay_valid,r.received_at,r.processed_at,r.processing_error,r.processing_attempt_count,r.terminated_at,r.content_purged_at,r.raw_payload_purged_at,pa.name AS account,pa.type
    FROM raw_provider_events r JOIN provider_accounts pa ON pa.id=r.provider_account_id ORDER BY r.received_at DESC LIMIT 200`),
  canonicalEvents: () => query(`SELECT * FROM (
    SELECT de.id,de.event_type,de.occurred_at,de.canonical_payload,d.recipient_email,'recipient' AS scope FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id
    UNION ALL SELECT e.id,e.event_type,e.occurred_at,e.canonical_payload,NULL AS recipient_email,'submission' AS scope FROM submission_events e
    ) events ORDER BY occurred_at DESC LIMIT 200`),
  suppressions: () => query(`SELECT s.id,s.scope_type,s.list_id,s.email_normalized,s.reason,s.source,s.bounce_count,s.expires_at,s.created_at,p.name AS product
    FROM suppressions s LEFT JOIN products p ON p.id=s.product_id WHERE s.active=true ORDER BY s.created_at DESC`),
  inbound: () => query(`SELECT i.id,i.service_id,i.content_purged_at,i.from_email,i.to_emails,i.subject,i.status,i.created_at AS received_at,i.author_date,i.ingress_received_at,i.ready_at,p.name AS product,count(a.id) AS attachment_count
    FROM inbound_messages i
    LEFT JOIN products p ON p.id=i.product_id
    LEFT JOIN inbound_attachments a ON a.inbound_message_id=i.id
    GROUP BY i.id,p.name ORDER BY i.created_at DESC LIMIT 200`),
  inboundRoutes: () => query(`SELECT r.id,r.status,sd.domain,p.name AS product,s.name AS service,e.opaque_token,pa.type AS provider_type,ce.name AS callback,
      CASE WHEN ce.id IS NULL THEN 'Polling only'
        WHEN ce.service_id IS DISTINCT FROM r.service_id THEN 'CALLBACK_BINDING_INVALID'
        WHEN ce.status<>'active' THEN 'CALLBACK_DISABLED'
        WHEN NOT('inbound.received'=ANY(ce.subscribed_events)) THEN 'CALLBACK_EVENT_NOT_SUBSCRIBED'
        ELSE 'Callback and polling configured' END AS notification_state
    FROM inbound_routes r
    JOIN sending_domains sd ON sd.id=r.sending_domain_id
    JOIN products p ON p.id=r.product_id
    LEFT JOIN services s ON s.id=r.service_id
    JOIN provider_webhook_endpoints e ON e.id=r.provider_webhook_endpoint_id
    JOIN provider_accounts pa ON pa.id=e.provider_account_id
    LEFT JOIN callback_endpoints ce ON ce.service_id=r.service_id
    ORDER BY r.created_at DESC`),
  failedWork: () => query("SELECT id,aggregate_type,aggregate_id,event_type,status,attempt_count,available_at,created_at FROM outbox_events WHERE status='failed' OR (status='pending' AND available_at<now()-interval '1 minute') ORDER BY available_at LIMIT 200"),
  audit: () => query("SELECT id,actor,action,resource_type,resource_id,details,created_at FROM audit_logs ORDER BY created_at DESC LIMIT 300")
};

async function rows(name: keyof typeof adminQueries) {
  return (await adminQueries[name]()).rows
}

export async function adminData(section: AdminSection) {
  switch (section) {
    case "attachments": {
      const [tasks,observations]=await Promise.all([
        query("SELECT resource_id,kind,service_id,status,reason,attempt_count,policy_version,checked_at,lease_expires_at,next_attempt_at FROM attachment_safety ORDER BY updated_at DESC,resource_id LIMIT 200"),
        query("SELECT status,count(*)::int AS count,max(checked_at) AS last_observed_at FROM attachment_safety GROUP BY status ORDER BY status")
      ]);
      return { tasks:tasks.rows,observations:observations.rows,configuration:scanPolicy() };
    }
    case "providers": {
      const providers = await rows("providers");
      return { providers, descriptors: providerDescriptors() };
    }
    case "domains": {
      const [providers, domains] = await Promise.all([rows("providers"), rows("domains")]);
      return { providers, domains, descriptors: providerDescriptors() };
    }
    case "routing": {
      const [products, services, domains, policies] = await Promise.all([rows("products"), rows("services"), rows("domains"), rows("policies")]);
      return { products, services, domains, policies };
    }
    case "api-keys": {
      const [products, services, domains, credentials, grants] = await Promise.all([rows("products"), rows("services"), rows("domains"), rows("credentials"), rows("grants")]);
      return { products, services, domains, credentials, grants };
    }
    case "webhooks": {
      const [services, callbacks, callbackDeliveries] = await Promise.all([rows("services"), rows("callbacks"), rows("callbackDeliveries")]);
      return { services, callbacks, callbackDeliveries };
    }
    case "events": {
      const [rawEvents, canonicalEvents] = await Promise.all([rows("rawEvents"), rows("canonicalEvents")]);
      return { rawEvents, canonicalEvents };
    }
    case "suppressions": {
      const [products, suppressions] = await Promise.all([rows("products"), rows("suppressions")]);
      return { products, suppressions };
    }
    case "inbound": {
      const [inbound, inboundRoutes, webhooks, domains, products, services, callbacks] = await Promise.all([
        rows("inbound"), rows("inboundRoutes"), rows("webhooks"), rows("domains"), rows("products"), rows("services"), rows("callbacks")
      ]);
      return { inbound, inboundRoutes, webhooks, domains, products, services, callbacks };
    }
    case "logs": {
      const [audit,failedWork]=await Promise.all([rows("audit"),rows("failedWork")]);
      return { audit, failedWork };
    }
  }
}
