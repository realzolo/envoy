import type { CanonicalEventDto } from '@/modules/admin/contracts';
import { query } from '@/platform/database';
export const outboundAdminReads = { canonicalEvents: () => query<CanonicalEventDto>(`SELECT * FROM (
    SELECT de.id,de.event_type,de.occurred_at,de.canonical_payload,d.recipient_email,'recipient' AS scope FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id
    UNION ALL SELECT e.id,e.event_type,e.occurred_at,e.canonical_payload,NULL AS recipient_email,'submission' AS scope FROM submission_events e
    ) events ORDER BY occurred_at DESC LIMIT 200`) };
