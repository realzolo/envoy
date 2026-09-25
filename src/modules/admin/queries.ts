import type { DeliveryStatus, EmailRecord } from "@/lib/types";
import { providerDescriptors } from "@/modules/providers/registry";
import { query } from "@/server/database";
import { workerHeartbeatAlive } from "@/server/redis";

function relative(date: Date) {
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`
}

function formatted(date: Date) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" }).format(date)
}

type EmailRow = {
  delivery_id: string;
  recipient_email: string;
  recipient_name: string | null;
  lifecycle_status: string;
  compliance_status: string;
  accepted_at: Date;
  reference_id: string | null;
  subject: string;
  category: string;
  product_name: string;
  from_name: string;
  from_local_part: string;
  domain: string;
  external_message_id: string | null
};
const emailSelect = `SELECT d.id AS delivery_id,d.recipient_email,d.recipient_name,d.lifecycle_status,d.compliance_status,d.engagement_status,d.message_id,d.current_attempt_id,m.accepted_at,m.reference_id,m.subject,m.message_category AS category,p.name AS product_name,sp.from_name,sp.from_local_part,sd.domain,da.external_message_id FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN products p ON p.id=m.product_id JOIN sender_profiles sp ON sp.id=m.sender_profile_id JOIN sending_domains sd ON sd.id=sp.sending_domain_id LEFT JOIN delivery_attempts da ON da.id=d.current_attempt_id`;

function mapEmail(row: EmailRow): EmailRecord {
  return {
    id: row.delivery_id,
    recipient: row.recipient_email,
    recipientName: row.recipient_name ?? undefined,
    subject: row.subject,
    category: row.category,
    product: row.product_name,
    from: `${row.from_name} <${row.from_local_part}@${row.domain}>`,
    status: (row.compliance_status === "suppressed" ? "suppressed" : row.lifecycle_status) as DeliveryStatus,
    createdAt: formatted(row.accepted_at),
    relativeTime: relative(row.accepted_at),
    providerId: row.external_message_id ?? undefined,
    referenceId: row.reference_id ?? undefined
  }
}

export async function listEmails(limit = 200) {
  return (await query<EmailRow>(`${emailSelect} ORDER BY m.accepted_at DESC LIMIT $1`, [limit])).rows.map(mapEmail)
}

export async function getDeliveryDetail(id: string) {
  const row = (await query<EmailRow & {
    message_id: string;
    engagement_status: string;
    current_attempt_id: string | null
  }>(`${emailSelect} WHERE d.id=$1`, [id])).rows[0];
  if (!row) return null;
  const attempts = (await query(`SELECT da.id,da.attempt_number,da.status,da.outcome_determinate,da.external_message_id,da.error_category,da.error_code,da.error_message,da.routing_snapshot,da.started_at,da.finished_at,pa.name AS provider_account,pa.type AS provider_type FROM delivery_attempts da JOIN provider_accounts pa ON pa.id=da.provider_account_id WHERE da.delivery_id=$1 ORDER BY da.attempt_number DESC`, [id])).rows;
  const events = (await query(`SELECT id,event_type,occurred_at,canonical_payload FROM delivery_events WHERE delivery_id=$1 ORDER BY occurred_at DESC`, [id])).rows;
  return {
    ...mapEmail(row),
    messageId: row.message_id,
    lifecycle: row.lifecycle_status,
    engagement: row.engagement_status,
    compliance: row.compliance_status,
    currentAttemptId: row.current_attempt_id,
    attempts,
    events
  }
}

export async function messageComposerData() {
  const [services, senders] = await Promise.all([
    query<{ id: string; name: string; product: string; product_id: string }>(`SELECT s.id,s.name,p.name AS product,p.id AS product_id
      FROM services s JOIN products p ON p.id=s.product_id
      WHERE p.status='active'
      ORDER BY p.name,s.name`),
    query<{ name: string; product_id: string; category: string; from_address: string }>(`SELECT sp.name,sp.product_id,sp.message_category AS category,
      sp.from_name||' <'||sp.from_local_part||'@'||sd.domain||'>' AS from_address
      FROM sender_profiles sp JOIN sending_domains sd ON sd.id=sp.sending_domain_id
      WHERE sp.status='active' AND sd.status='active'
      ORDER BY sp.name`)
  ]);
  return { services: services.rows, senders: senders.rows }
}

export async function dashboardData() {
  const [counts, recent, trend, outbox, deadLetters, unknown, setup, workerAlive] = await Promise.all([query<{
    accepted: string;
    delivered: string;
    bounced: string;
    total: string
  }>(`SELECT count(DISTINCT m.id)FILTER(WHERE m.accepted_at>=now()-interval '7 days') AS accepted,count(*)FILTER(WHERE d.lifecycle_status='delivered' AND m.accepted_at>=now()-interval '7 days') AS delivered,count(*)FILTER(WHERE d.lifecycle_status='bounced' AND m.accepted_at>=now()-interval '7 days') AS bounced,count(*)FILTER(WHERE m.accepted_at>=now()-interval '7 days') AS total FROM messages m LEFT JOIN deliveries d ON d.message_id=m.id`), listEmails(5), query<{
    day: Date;
    sent: string;
    delivered: string
  }>(`WITH days AS (SELECT generate_series(current_date - interval '6 days', current_date, interval '1 day')::date AS day) SELECT days.day,count(d.id) FILTER (WHERE d.accepted_at::date=days.day) AS sent,count(d.id) FILTER (WHERE d.delivered_at::date=days.day) AS delivered FROM days LEFT JOIN deliveries d ON d.queued_at>=current_date - interval '6 days' GROUP BY days.day ORDER BY days.day`), query<{
    pending: string;
    failed: string;
  }>("SELECT count(*) FILTER(WHERE status='pending') AS pending,count(*) FILTER(WHERE status='failed') AS failed FROM outbox_events"), query<{
    count: string
  }>("SELECT count(*) FROM callback_deliveries WHERE status='dead_letter'"), query<{
    count: string
  }>("SELECT count(*) FROM deliveries WHERE lifecycle_status='unknown'"), query<{
    providers: string;
    identities: string;
    products: string;
    senders: string;
    routes: string;
    credentials: string;
    messages: string;
  }>(`SELECT
      (SELECT count(*) FROM provider_accounts WHERE status='active')::text AS providers,
      (SELECT count(*) FROM provider_identities WHERE status='verified')::text AS identities,
      (SELECT count(*) FROM products WHERE status='active')::text AS products,
      (SELECT count(*) FROM sender_profiles WHERE status='active')::text AS senders,
      (SELECT count(*) FROM routing_targets rt JOIN routing_policies rp ON rp.id=rt.policy_id WHERE rt.status='active' AND rp.status='active')::text AS routes,
      (SELECT count(*) FROM service_credentials c JOIN services s ON s.id=c.service_id JOIN products p ON p.id=s.product_id WHERE c.status='active' AND p.status='active')::text AS credentials,
      (SELECT count(*) FROM messages)::text AS messages`), workerHeartbeatAlive()]);
  const c = counts.rows[0] ?? { accepted: "0", delivered: "0", bounced: "0", total: "0" };
  const total = Number(c.total);
  return {
    stats: {
      accepted: Number(c.accepted),
      delivered: Number(c.delivered),
      bounced: Number(c.bounced),
      deliveryRate: total ? Number(c.delivered) / total * 100 : 0,
      bounceRate: total ? Number(c.bounced) / total * 100 : 0
    },
    recent,
    trend: trend.rows.map(row => ({
      label: new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric"
      }).format(row.day), sent: Number(row.sent), delivered: Number(row.delivered)
    })),
    health: {
      outbox: Number(outbox.rows[0]?.pending ?? 0),
      outboxFailed: Number(outbox.rows[0]?.failed ?? 0),
      deadLetters: Number(deadLetters.rows[0]?.count ?? 0),
      unknown: Number(unknown.rows[0]?.count ?? 0),
      workerAlive
    },
    setup: {
      providers: Number(setup.rows[0]?.providers ?? 0),
      identities: Number(setup.rows[0]?.identities ?? 0),
      products: Number(setup.rows[0]?.products ?? 0),
      senders: Number(setup.rows[0]?.senders ?? 0),
      routes: Number(setup.rows[0]?.routes ?? 0),
      credentials: Number(setup.rows[0]?.credentials ?? 0),
      messages: Number(setup.rows[0]?.messages ?? 0)
    }
  }
}

export type AdminSection =
  | "providers"
  | "domains"
  | "senders"
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
    e.security_configured,e.expected_topic_arn,e.ip_allowlist
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
  senders: () => query(`SELECT sp.id,sp.name,sp.from_name,sp.from_local_part,sp.reply_to,sp.message_category,sp.status,p.name AS product,p.id AS product_id,sd.domain,sd.id AS domain_id
    FROM sender_profiles sp JOIN products p ON p.id=sp.product_id JOIN sending_domains sd ON sd.id=sp.sending_domain_id
    ORDER BY p.name,sp.name`),
  policies: () => query(`SELECT rp.id,rp.name,rp.priority,rp.status,p.name AS product,s.name AS service,sd_policy.domain AS sending_domain,rp.message_category,
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
    count(d.id) FILTER(WHERE d.status='dead_letter') AS dead_letters
    FROM callback_endpoints e
    JOIN services s ON s.id=e.service_id
    JOIN products p ON p.id=s.product_id
    LEFT JOIN callback_deliveries d ON d.endpoint_id=e.id
    GROUP BY e.id,s.id,s.name,p.id,p.name ORDER BY e.created_at DESC`),
  rawEvents: () => query(`SELECT r.id,r.native_type,r.provider_event_id,r.signature_valid,r.replay_valid,r.received_at,r.processed_at,r.processing_error,pa.name AS account,pa.type
    FROM raw_provider_events r JOIN provider_accounts pa ON pa.id=r.provider_account_id ORDER BY r.received_at DESC LIMIT 200`),
  canonicalEvents: () => query(`SELECT de.id,de.event_type,de.occurred_at,de.canonical_payload,d.recipient_email
    FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id ORDER BY de.occurred_at DESC LIMIT 200`),
  suppressions: () => query(`SELECT s.id,s.scope_type,s.list_id,s.email_normalized,s.reason,s.source,s.bounce_count,s.expires_at,s.created_at,p.name AS product
    FROM suppressions s LEFT JOIN products p ON p.id=s.product_id WHERE s.active=true ORDER BY s.created_at DESC`),
  inbound: () => query(`SELECT i.id,i.from_email,i.to_emails,i.subject,i.status,i.received_at,p.name AS product,count(a.id) AS attachment_count
    FROM inbound_messages i
    LEFT JOIN products p ON p.id=i.product_id
    LEFT JOIN inbound_attachments a ON a.inbound_message_id=i.id
    GROUP BY i.id,p.name ORDER BY i.received_at DESC LIMIT 200`),
  inboundRoutes: () => query(`SELECT r.id,r.local_part_pattern,r.status,sd.domain,p.name AS product,s.name AS service,e.opaque_token,pa.type AS provider_type,ce.name AS callback
    FROM inbound_routes r
    JOIN sending_domains sd ON sd.id=r.sending_domain_id
    JOIN products p ON p.id=r.product_id
    LEFT JOIN services s ON s.id=r.service_id
    JOIN provider_webhook_endpoints e ON e.id=r.provider_webhook_endpoint_id
    JOIN provider_accounts pa ON pa.id=e.provider_account_id
    LEFT JOIN callback_endpoints ce ON ce.id=r.callback_endpoint_id
    ORDER BY r.created_at DESC`),
  audit: () => query("SELECT id,actor,action,resource_type,resource_id,details,created_at FROM audit_logs ORDER BY created_at DESC LIMIT 300")
};

async function rows(name: keyof typeof adminQueries) {
  return (await adminQueries[name]()).rows
}

export async function adminData(section: AdminSection) {
  switch (section) {
    case "providers": {
      const providers = await rows("providers");
      return { providers, descriptors: providerDescriptors() };
    }
    case "domains": {
      const [providers, domains] = await Promise.all([rows("providers"), rows("domains")]);
      return { providers, domains, descriptors: providerDescriptors() };
    }
    case "senders": {
      const [products, domains, senders] = await Promise.all([rows("products"), rows("domains"), rows("senders")]);
      return { products, domains, senders };
    }
    case "routing": {
      const [products, services, domains, policies] = await Promise.all([rows("products"), rows("services"), rows("domains"), rows("policies")]);
      return { products, services, domains, policies };
    }
    case "api-keys": {
      const [products, credentials] = await Promise.all([rows("products"), rows("credentials")]);
      return { products, credentials };
    }
    case "webhooks": {
      const [services, callbacks] = await Promise.all([rows("services"), rows("callbacks")]);
      return { services, callbacks };
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
      return { audit: await rows("audit") };
    }
  }
}
