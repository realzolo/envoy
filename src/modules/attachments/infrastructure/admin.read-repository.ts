import {query} from '@/platform/database';
import type {AttachmentTaskDto,AttachmentObservationDto} from '@/modules/admin/contracts';
export const attachmentAdminReads={tasks:()=>query<AttachmentTaskDto>('SELECT resource_id,kind,service_id,status,reason,attempt_count,policy_version,checked_at,lease_expires_at,next_attempt_at FROM attachment_safety ORDER BY updated_at DESC,resource_id LIMIT 200'),observations:()=>query<AttachmentObservationDto>('SELECT status,count(*)::int AS count,max(checked_at) AS last_observed_at FROM attachment_safety GROUP BY status ORDER BY status')};
