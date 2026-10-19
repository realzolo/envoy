import type { DomainDto,ProviderAccountDto,ProviderWebhookDto } from '@/modules/admin/contracts';
import { query } from '@/platform/database';
export const channelsAdminReads={providers: () => query<ProviderAccountDto>(`SELECT a.id,a.type,a.name,a.status,a.public_config,
    coalesce(a.health->>'status','unknown') AS health,a.health AS health_details,a.quota,a.created_at,
    c.credential_version,e.id AS webhook_endpoint_id,e.opaque_token,e.status AS webhook_status,
    e.security_configured,e.expected_topic_arn,e.ip_allowlist,
    (SELECT max(r.received_at) FROM raw_provider_events r WHERE r.provider_account_id=a.id AND r.webhook_endpoint_id=e.id AND r.signature_valid AND r.replay_valid AND r.security_version=e.security_version) AS last_event_at
    FROM provider_accounts a
    JOIN provider_credentials c ON c.provider_account_id=a.id AND c.status='active'
    JOIN provider_webhook_endpoints e ON e.provider_account_id=a.id
    ORDER BY a.name`),
domains: () => query<DomainDto>(`SELECT sd.id,sd.domain,sd.status,
    (SELECT count(*)::int FROM service_domain_bindings b
      JOIN services s ON s.id=b.service_id AND s.status='active'
      WHERE b.sending_domain_id=sd.id AND b.receive_enabled) AS receiving_service_count,
    json_agg(json_build_object('id',pi.id,'accountId',pa.id,'account',pa.name,'type',pa.type,'accountStatus',pa.status,'status',pi.status,'externalId',pi.external_identity_id,'dnsRecords',pi.dns_records,'lastCheckedAt',pi.last_checked_at) ORDER BY pa.name)
      FILTER(WHERE pi.id IS NOT NULL) AS identities
    FROM sending_domains sd
    LEFT JOIN provider_identities pi ON pi.sending_domain_id=sd.id
    LEFT JOIN provider_accounts pa ON pa.id=pi.provider_account_id
    GROUP BY sd.id ORDER BY sd.domain`),
webhooks: () => query<ProviderWebhookDto>(`SELECT e.id,e.opaque_token,e.status,e.security_configured,e.expected_topic_arn,e.ip_allowlist,e.created_at,pa.id AS provider_account_id,pa.name AS account,pa.type
    FROM provider_webhook_endpoints e JOIN provider_accounts pa ON pa.id=e.provider_account_id ORDER BY e.created_at DESC`)};
