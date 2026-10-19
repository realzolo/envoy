import type { ServiceCredentialDto,ServiceDto } from '@/modules/admin/contracts';
import { query } from '@/platform/database';
export const identityAdminReads={
services: () => query<ServiceDto>(`SELECT s.id,s.name,s.status,s.suppression_management_allowed,s.configuration_revision,
  COALESCE((SELECT json_agg(b.* ORDER BY b.sending_domain_id) FROM service_domain_bindings b WHERE b.service_id=s.id),'[]'::json) AS domain_bindings,
  e.id AS callback_id,e.url AS callback_url,e.status AS callback_status
  FROM services s LEFT JOIN callback_endpoints e ON e.service_id=s.id ORDER BY s.name`),
credentials: () => query<ServiceCredentialDto>(`SELECT c.id,c.key_prefix,c.status,c.created_at,c.valid_from,c.valid_to,c.last_used_at,s.name AS service,s.id AS service_id
  FROM service_credentials c JOIN services s ON s.id=c.service_id ORDER BY c.created_at DESC`)
};
export async function activeServiceExists(id:string|null){return Boolean((await query<{id:string}>("SELECT id FROM services WHERE id=$1 AND status='active'",[id])).rowCount);}
