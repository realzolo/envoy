import { providerRegistry } from "@/modules/providers/registry";
import type { ProviderType } from "@/modules/providers/contracts";
import type { ServiceIdentity } from "@/server/auth";
import { query } from "@/server/database";

const iso = (value: Date | null) => value?.toISOString() ?? null;

/** Public configuration facts and observed evidence; never a reservation or a send authorization cache. */
export async function discoverMail(identity: ServiceIdentity) {
  const senders = (await query<{
    id: string; domain: string; from_local_part: string | null; service_id: string | null;
    status: string; domain_status: string; display_name: string | null;
    categories: (string | null)[]; last_accepted_at: Date | null; last_delivered_at: Date | null;
  }>(`SELECT g.id,d.domain,g.from_local_part,g.service_id,g.status,d.status AS domain_status,
    (SELECT sp.from_name FROM sender_profiles sp WHERE sp.product_id=g.product_id AND sp.sending_domain_id=d.id
      AND sp.from_local_part=g.from_local_part AND sp.status='active' ORDER BY sp.id LIMIT 1) AS display_name,
    ARRAY(SELECT DISTINCT rp.message_category FROM routing_policies rp JOIN routing_targets rt ON rt.policy_id=rp.id
      JOIN provider_accounts a ON a.id=rt.provider_account_id JOIN provider_identities pi ON pi.id=rt.provider_identity_id
      WHERE rp.sending_domain_id=d.id AND rp.status='active' AND (rp.product_id IS NULL OR rp.product_id=$1)
        AND (rp.service_id IS NULL OR rp.service_id=$2) AND a.status='active' AND pi.status='verified'
        AND pi.sending_domain_id=d.id AND pi.provider_account_id=a.id
        AND COALESCE(a.health->>'status','unknown') NOT IN ('unhealthy','offline')
        AND (rt.status='active' OR rt.circuit_open_until<=now())
        AND EXISTS(SELECT 1 FROM provider_credentials c WHERE c.provider_account_id=a.id AND c.status='active'
          AND c.valid_from<=now() AND (c.valid_to IS NULL OR c.valid_to>now()))) AS categories,
    facts.last_accepted_at,facts.last_delivered_at
    FROM sender_grants g JOIN sending_domains d ON d.id=g.sending_domain_id
    LEFT JOIN LATERAL (
      SELECT max(f.occurred_at) FILTER (WHERE f.event_type='accepted') AS last_accepted_at,
        max(f.occurred_at) FILTER (WHERE f.event_type='delivered') AS last_delivered_at
      FROM (
        SELECT e.occurred_at,e.event_type FROM delivery_events e JOIN deliveries dl ON dl.id=e.delivery_id JOIN messages m ON m.id=dl.message_id
        WHERE m.service_id=$2 AND m.sending_domain_id=d.id AND e.event_type IN ('accepted','delivered')
          AND (g.from_local_part IS NULL OR split_part(m.sender_snapshot->>'fromEmail','@',1)=g.from_local_part)
        UNION ALL
        SELECT e.occurred_at,e.event_type FROM submission_events e JOIN submissions s ON s.id=e.submission_id JOIN messages m ON m.id=s.message_id
        WHERE m.service_id=$2 AND m.sending_domain_id=d.id AND e.event_type IN ('accepted','delivered')
          AND (g.from_local_part IS NULL OR split_part(m.sender_snapshot->>'fromEmail','@',1)=g.from_local_part)
      ) f
    ) facts ON true
    WHERE g.product_id=$1 AND (g.service_id IS NULL OR g.service_id=$2) ORDER BY d.domain,g.id`, [identity.productId,identity.serviceId])).rows;
  const receivers = (await query<{
    id: string; domain: string; local_part_pattern: string; status: string; domain_status: string;
    callback_endpoint_id: string | null; callback_owner: string | null; callback_status: string | null; subscribed_events: string[] | null;
    endpoint_status: string; security_configured: boolean; provider_type: ProviderType; last_received_at: Date | null;
  }>(`SELECT r.id,d.domain,r.local_part_pattern,r.status,d.status AS domain_status,e.status AS endpoint_status,e.security_configured,a.type AS provider_type,r.callback_endpoint_id,cb.service_id AS callback_owner,cb.status AS callback_status,cb.subscribed_events,
      (SELECT max(i.created_at) FROM inbound_messages i WHERE i.service_id=$2 AND i.provider_account_id=e.provider_account_id AND i.status='ready'
        AND EXISTS(SELECT 1 FROM unnest(i.envelope_recipients) recipient WHERE split_part(recipient,'@',2)=d.domain
          AND split_part(recipient,'@',1) LIKE replace(replace(replace(r.local_part_pattern,'~','~~'),'_','~_'),'*','%') ESCAPE '~')) AS last_received_at
    FROM inbound_routes r JOIN sending_domains d ON d.id=r.sending_domain_id
    JOIN provider_webhook_endpoints e ON e.id=r.provider_webhook_endpoint_id JOIN provider_accounts a ON a.id=e.provider_account_id
    LEFT JOIN callback_endpoints cb ON cb.id=r.callback_endpoint_id
    WHERE r.product_id=$1 AND r.service_id=$2 ORDER BY d.domain,r.id`, [identity.productId,identity.serviceId])).rows;
  const callbacks = (await query<{ configured: boolean; last_delivered_at: Date | null; latest: { status: string; attemptCount: number; deliveredAt: string | null } | null }>(`SELECT
    EXISTS(SELECT 1 FROM callback_endpoints WHERE service_id=$1 AND status='active') AS configured,
    (SELECT max(c.delivered_at) FROM callback_deliveries c JOIN callback_endpoints e ON e.id=c.endpoint_id WHERE e.service_id=$1) AS last_delivered_at,
    (SELECT jsonb_build_object('status',c.status,'attemptCount',c.attempt_count,'deliveredAt',c.delivered_at)
      FROM callback_deliveries c JOIN callback_endpoints e ON e.id=c.endpoint_id WHERE e.service_id=$1 ORDER BY c.created_at DESC,c.id DESC LIMIT 1) AS latest`, [identity.serviceId])).rows[0];
  return {
    kind: "address_permissions" as const, mailboxLogin: false as const,
    senders: senders.map(row => {
      const reasons = [...(row.status !== "active" ? ["SENDER_NOT_AUTHORIZED"] : []), ...(row.domain_status !== "active" ? ["SENDING_DOMAIN_DISABLED"] : []), ...(!row.categories.length ? ["NO_ELIGIBLE_ROUTE"] : [])];
      const exact = row.from_local_part !== null;
      return { id: row.id, kind: exact ? "exact_address" as const : "domain" as const, domain: row.domain,
        address: exact ? `${row.from_local_part}@${row.domain}` : null, displayName: row.display_name,
        scope: row.service_id ? "service" as const : "product" as const,
        authorization: row.status === "active" ? "granted" as const : "revoked" as const,
        sending: { state: reasons.length ? "unavailable" as const : "configured" as const, reasonCodes: reasons, categories: row.categories, runtimeAvailability: "unknown" as const },
        evidence: { lastAcceptedAt: iso(row.last_accepted_at), lastDeliveredAt: iso(row.last_delivered_at) } };
    }),
    receivers: receivers.map(row => {
      const reasons = [...(row.status !== "active" ? ["INBOUND_ROUTE_DISABLED"] : []), ...(row.domain_status !== "active" ? ["INBOUND_DOMAIN_DISABLED"] : []), ...(row.endpoint_status !== "active" || !row.security_configured ? ["INBOUND_INGRESS_UNAVAILABLE"] : [])];
      const unsupported = !providerRegistry(row.provider_type).descriptor.capabilities.inboundEnvelopeRecipients;
      if (unsupported) reasons.push("ENVELOPE_RECIPIENT_UNAVAILABLE");
      const notificationReasons = row.callback_endpoint_id ? [
        ...(row.callback_owner !== identity.serviceId ? ["CALLBACK_BINDING_INVALID"] : []),
        ...(row.callback_status !== "active" ? ["CALLBACK_DISABLED"] : []),
        ...(!row.subscribed_events?.includes("inbound.received") ? ["CALLBACK_EVENT_NOT_SUBSCRIBED"] : []),
      ] : [];
      return { id: row.id, kind: row.local_part_pattern.includes("*") ? "local_part_pattern" as const : "exact_address" as const,
        address: row.local_part_pattern.includes("*") ? null : `${row.local_part_pattern}@${row.domain}`,
        domain: row.domain, localPartPattern: row.local_part_pattern, displayName: null,
        receiving: { state: reasons.length ? "unavailable" as const : "configured" as const, reasonCodes: reasons, externalReadiness: "unknown" as const },
        notification: { mode: row.callback_endpoint_id ? "callback_and_polling" as const : "polling" as const,
          state: notificationReasons.length ? "unavailable" as const : "configured" as const,
          callbackEndpointId: row.callback_owner === identity.serviceId ? row.callback_endpoint_id : null,
          reasonCodes: notificationReasons, recoveryResource: "/api/v1/inbound-changes" as const },
        evidence: { lastReceivedAt: iso(row.last_received_at) } };
    }),
    callbacks: { configuration: callbacks.configured ? "configured" as const : "unavailable" as const,
      latest: callbacks.latest, lastDeliveredAt: iso(callbacks.last_delivered_at), businessProcessing: "unknown" as const },
  };
}
