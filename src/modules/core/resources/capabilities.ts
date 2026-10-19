import { providerRegistry } from "@/modules/providers/registry";
import type { ProviderType } from "@/modules/providers/contracts";
import type { ServiceIdentity } from "@/server/auth";
import { query } from "@/server/database";
import { effectiveDomainGrants } from "./authorization";

const iso = (value: Date | null) => value?.toISOString() ?? null;

/** Discovery separates permission, configured transport and historical evidence. */
export async function discoverMail(identity: ServiceIdentity) {
  const grants = (await query<{
    id:string;domain:string;status:string;domain_status:string;send_allowed:boolean;receive_allowed:boolean;revision:number;
    sending_configured:boolean;last_accepted_at:Date|null;last_delivered_at:Date|null;last_received_at:Date|null;
  }>(`SELECT d.id,d.domain,g.status,d.status AS domain_status,g.send_allowed,g.receive_allowed,g.revision,
    EXISTS(SELECT 1 FROM routing_policies rp JOIN routing_targets rt ON rt.policy_id=rp.id
      JOIN provider_accounts a ON a.id=rt.provider_account_id JOIN provider_identities pi ON pi.id=rt.provider_identity_id
      WHERE rp.sending_domain_id=d.id AND rp.status='active' AND (rp.product_id IS NULL OR rp.product_id=$1)
        AND (rp.service_id IS NULL OR rp.service_id=$2) AND a.status='active' AND pi.status='verified'
        AND pi.sending_domain_id=d.id AND pi.provider_account_id=a.id
        AND COALESCE(a.health->>'status','unknown') NOT IN ('unhealthy','offline')
        AND (rt.status='active' OR rt.circuit_open_until<=now())
        AND EXISTS(SELECT 1 FROM provider_credentials c WHERE c.provider_account_id=a.id AND c.status='active'
          AND c.valid_from<=now() AND (c.valid_to IS NULL OR c.valid_to>now()))) AS sending_configured,
    (SELECT max(f.occurred_at) FROM (
      SELECT e.occurred_at FROM delivery_events e JOIN deliveries dl ON dl.id=e.delivery_id JOIN messages m ON m.id=dl.message_id WHERE m.service_id=$2 AND m.sending_domain_id=d.id AND e.event_type='accepted'
      UNION ALL SELECT e.occurred_at FROM submission_events e JOIN submissions s ON s.id=e.submission_id JOIN messages m ON m.id=s.message_id WHERE m.service_id=$2 AND m.sending_domain_id=d.id AND e.event_type='accepted'
    ) f) AS last_accepted_at,
    (SELECT max(f.occurred_at) FROM (
      SELECT e.occurred_at FROM delivery_events e JOIN deliveries dl ON dl.id=e.delivery_id JOIN messages m ON m.id=dl.message_id WHERE m.service_id=$2 AND m.sending_domain_id=d.id AND e.event_type='delivered'
      UNION ALL SELECT e.occurred_at FROM submission_events e JOIN submissions s ON s.id=e.submission_id JOIN messages m ON m.id=s.message_id WHERE m.service_id=$2 AND m.sending_domain_id=d.id AND e.event_type='delivered'
    ) f) AS last_delivered_at,
    (SELECT max(i.created_at) FROM inbound_messages i WHERE i.service_id=$2 AND i.status='ready' AND EXISTS(SELECT 1 FROM unnest(i.envelope_recipients) er WHERE split_part(er,'@',2)=d.domain)) AS last_received_at
    FROM sending_domains d JOIN LATERAL (${effectiveDomainGrants("$2", "d.id")}) g ON true
    ORDER BY d.domain`,[identity.productId,identity.serviceId])).rows;
  const routes = (await query<{domain_id:string;status:string;endpoint_status:string;security_configured:boolean;provider_type:ProviderType}>(`SELECT r.sending_domain_id AS domain_id,r.status,e.status AS endpoint_status,e.security_configured,a.type AS provider_type
    FROM inbound_routes r JOIN provider_webhook_endpoints e ON e.id=r.provider_webhook_endpoint_id
    JOIN provider_accounts a ON a.id=e.provider_account_id WHERE r.service_id=$1`,[identity.serviceId])).rows;
  const callback = (await query<{id:string;status:string;subscribed_events:string[];last_delivered_at:Date|null;latest:{status:string;attemptCount:number;deliveredAt:string|null}|null}>(`SELECT e.id,e.status,e.subscribed_events,
    (SELECT max(c.delivered_at) FROM callback_deliveries c WHERE c.endpoint_id=e.id) AS last_delivered_at,
    (SELECT jsonb_build_object('status',c.status,'attemptCount',c.attempt_count,'deliveredAt',c.delivered_at) FROM callback_deliveries c WHERE c.endpoint_id=e.id ORDER BY c.created_at DESC,c.id DESC LIMIT 1) AS latest
    FROM callback_endpoints e WHERE e.service_id=$1`,[identity.serviceId])).rows[0];
  return {
    kind:"domain_permissions" as const,
    domains:grants.map(row=>{
      const active=row.status==='active';
      const sendingReasons=[...(!active||!row.send_allowed?['DOMAIN_SEND_NOT_AUTHORIZED']:[]),...(row.domain_status!=='active'?['SENDING_DOMAIN_DISABLED']:[]),...(!row.sending_configured?['NO_ELIGIBLE_ROUTE']:[])];
      const ownRoutes=routes.filter(route=>route.domain_id===row.id);
      const ingress=ownRoutes.some(route=>route.status==='active'&&route.endpoint_status==='active'&&route.security_configured&&providerRegistry(route.provider_type).descriptor.capabilities.inboundEnvelopeRecipients);
      const receivingReasons=[...(!active||!row.receive_allowed?['DOMAIN_RECEIVE_NOT_AUTHORIZED']:[]),...(row.domain_status!=='active'?['INBOUND_DOMAIN_DISABLED']:[]),...(!ingress?['INBOUND_INGRESS_UNAVAILABLE']:[])];
      const notificationReasons=callback?[...(callback.status!=='active'?['CALLBACK_DISABLED']:[]),...(!callback.subscribed_events.includes('inbound.received')?['CALLBACK_EVENT_NOT_SUBSCRIBED']:[])]:[];
      return {id:row.id,domain:row.domain,authorization:active?'granted' as const:'revoked' as const,revision:row.revision,
        permissions:{send:active&&row.send_allowed,receive:active&&row.receive_allowed},
        sending:{state:sendingReasons.length?'unavailable' as const:'configured' as const,reasonCodes:sendingReasons},
        receiving:{state:receivingReasons.length?'unavailable' as const:'configured' as const,reasonCodes:receivingReasons},
        notification:{mode:callback?'callback_and_polling' as const:'polling' as const,state:notificationReasons.length?'unavailable' as const:'configured' as const,reasonCodes:notificationReasons},
        evidence:{lastAcceptedAt:iso(row.last_accepted_at),lastDeliveredAt:iso(row.last_delivered_at),lastReceivedAt:iso(row.last_received_at)}};
    }),
    callbacks:{configuration:callback?.status==='active'?'configured' as const:'unavailable' as const,latest:callback?.latest??null,lastDeliveredAt:iso(callback?.last_delivered_at??null),businessProcessing:'unknown' as const},
  };
}
