import type { ProviderType } from '@/integrations/providers/contracts';
import { query } from '@/platform/database';
import type { DiscoveryRepository } from '../application/discovery-ports';
import { effectiveDomainGrants } from './authorization';
export const discoveryRepository:DiscoveryRepository={
listDomainCapabilities(productId:string,serviceId:string){return query<{
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
    ORDER BY d.domain`,[productId,serviceId]);},
listInboundRoutes(productId:string,serviceId:string){return query<{domain_id:string;status:string;endpoint_status:string;security_configured:boolean;provider_type:ProviderType}>(`SELECT r.sending_domain_id AS domain_id,r.status,e.status AS endpoint_status,e.security_configured,a.type AS provider_type
    FROM inbound_routes r JOIN provider_webhook_endpoints e ON e.id=r.provider_webhook_endpoint_id
    JOIN provider_accounts a ON a.id=e.provider_account_id WHERE r.service_id=$1`,[serviceId]);},
findServiceCallback(productId:string,serviceId:string){return query<{id:string;status:string;subscribed_events:string[];last_delivered_at:Date|null;latest:{status:string;attemptCount:number;deliveredAt:string|null}|null}>(`SELECT e.id,e.status,e.subscribed_events,
    (SELECT max(c.delivered_at) FROM callback_deliveries c WHERE c.endpoint_id=e.id) AS last_delivered_at,
    (SELECT jsonb_build_object('status',c.status,'attemptCount',c.attempt_count,'deliveredAt',c.delivered_at) FROM callback_deliveries c WHERE c.endpoint_id=e.id ORDER BY c.created_at DESC,c.id DESC LIMIT 1) AS latest
    FROM callback_endpoints e WHERE e.service_id=$1 AND e.url IS NOT NULL`,[serviceId]);}
};
