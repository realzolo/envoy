import {query} from '@/platform/database';
import type {SuppressionDto} from '@/modules/admin/contracts';
export const suppressionAdminReads={suppressions: () => query<SuppressionDto>(`SELECT s.id,s.scope_type,s.list_id,s.email_normalized,s.reason,s.source,s.bounce_count,s.expires_at,s.created_at,p.name AS service
    FROM suppressions s LEFT JOIN services p ON p.id=s.service_id WHERE s.active=true ORDER BY s.created_at DESC`)};
