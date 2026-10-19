import type { CanonicalEventDto, RoutingPolicyDto } from '@/modules/admin/contracts';
import { query } from '@/platform/database';
export const outboundAdminReads = { policies: () => query<RoutingPolicyDto>(`SELECT rp.id,rp.name,rp.priority,rp.status,rp.product_id,rp.service_id,rp.sending_domain_id,p.name AS product,s.name AS service,sd_policy.domain AS sending_domain,rp.message_category,
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
    canonicalEvents: () => query<CanonicalEventDto>(`SELECT * FROM (
    SELECT de.id,de.event_type,de.occurred_at,de.canonical_payload,d.recipient_email,'recipient' AS scope FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id
    UNION ALL SELECT e.id,e.event_type,e.occurred_at,e.canonical_payload,NULL AS recipient_email,'submission' AS scope FROM submission_events e
    ) events ORDER BY occurred_at DESC LIMIT 200`) };
