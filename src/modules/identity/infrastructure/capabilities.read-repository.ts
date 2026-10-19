import { query } from '@/platform/database';
import type { DiscoveryRepository } from '../application/discovery-ports';

export const discoveryRepository: DiscoveryRepository = {
  listDomainCapabilities(serviceId: string) {
    return query<{
      id: string; domain: string; status: string; domain_status: string;
      send_allowed: boolean; receive_allowed: boolean; revision: number;
      sending_configured: boolean; ingress_ready: boolean;
      last_accepted_at: Date | null; last_delivered_at: Date | null; last_received_at: Date | null;
    }>(`SELECT d.id,d.domain,'active' AS status,d.status AS domain_status,
      (b.outbound_provider_identity_id IS NOT NULL) AS send_allowed,
      b.receive_enabled AS receive_allowed,
      s.configuration_revision AS revision,
      EXISTS(SELECT 1 FROM provider_identities pi
        JOIN provider_accounts a ON a.id=pi.provider_account_id
        WHERE pi.id=b.outbound_provider_identity_id AND pi.sending_domain_id=d.id
          AND pi.status='verified' AND a.status='active'
          AND COALESCE(a.health->>'status','unknown') NOT IN ('unhealthy','offline')
          AND EXISTS(SELECT 1 FROM provider_credentials c WHERE c.provider_account_id=a.id
            AND c.status='active' AND c.valid_from<=now() AND (c.valid_to IS NULL OR c.valid_to>now()))) AS sending_configured,
      EXISTS(SELECT 1 FROM provider_accounts ia
        JOIN provider_webhook_endpoints ie ON ie.provider_account_id=ia.id
        WHERE ia.status='active' AND ie.status='active' AND ie.security_configured) AS ingress_ready,
      (SELECT max(f.occurred_at) FROM (
        SELECT e.occurred_at FROM delivery_events e JOIN deliveries dl ON dl.id=e.delivery_id JOIN messages m ON m.id=dl.message_id WHERE m.service_id=$1 AND m.sending_domain_id=d.id AND e.event_type='accepted'
        UNION ALL SELECT e.occurred_at FROM submission_events e JOIN submissions sub ON sub.id=e.submission_id JOIN messages m ON m.id=sub.message_id WHERE m.service_id=$1 AND m.sending_domain_id=d.id AND e.event_type='accepted'
      ) f) AS last_accepted_at,
      (SELECT max(e.occurred_at) FROM delivery_events e JOIN deliveries dl ON dl.id=e.delivery_id JOIN messages m ON m.id=dl.message_id WHERE m.service_id=$1 AND m.sending_domain_id=d.id AND e.event_type='delivered') AS last_delivered_at,
      (SELECT max(i.created_at) FROM inbound_messages i WHERE i.service_id=$1 AND i.status='ready'
        AND EXISTS(SELECT 1 FROM unnest(i.envelope_recipients) er WHERE split_part(er,'@',2)=d.domain)) AS last_received_at
      FROM service_domain_bindings b
      JOIN sending_domains d ON d.id=b.sending_domain_id
      JOIN services s ON s.id=b.service_id
      WHERE b.service_id=$1 ORDER BY d.domain`, [serviceId]);
  },
  findServiceCallback(serviceId: string) {
    return query<{id:string;status:string;subscribed_events:string[];last_delivered_at:Date|null;latest:{status:string;attemptCount:number;deliveredAt:string|null}|null}>(`SELECT e.id,e.status,e.subscribed_events,
      (SELECT max(c.delivered_at) FROM callback_deliveries c WHERE c.endpoint_id=e.id) AS last_delivered_at,
      (SELECT jsonb_build_object('status',c.status,'attemptCount',c.attempt_count,'deliveredAt',c.delivered_at) FROM callback_deliveries c WHERE c.endpoint_id=e.id ORDER BY c.created_at DESC,c.id DESC LIMIT 1) AS latest
      FROM callback_endpoints e WHERE e.service_id=$1 AND e.url IS NOT NULL`,[serviceId]);
  }
};
