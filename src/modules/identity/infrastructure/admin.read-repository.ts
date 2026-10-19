import type { DomainGrantDto,ServiceCredentialDto,ServiceDto } from '@/modules/admin/contracts';
import { database,query } from '@/platform/database';
import { products } from '@/platform/database/schema/identity';
export const identityAdminReads={products: async () => {const rows=await database().select({id:products.id,name:products.name,status:products.status}).from(products).orderBy(products.name);return {rows,rowCount:rows.length};},
services: () => query<ServiceDto>("SELECT s.id,s.name,s.suppression_management_allowed,s.configuration_revision,COALESCE((SELECT json_agg(g.* ORDER BY g.id) FROM service_domain_grants g WHERE g.service_id=s.id),'[]'::json) AS domain_grants,p.name AS product,p.id AS product_id,p.status AS product_status,e.id AS callback_id,e.url AS callback_url,e.status AS callback_status FROM services s JOIN products p ON p.id=s.product_id LEFT JOIN callback_endpoints e ON e.service_id=s.id ORDER BY p.name,s.name"),
grants:()=>query<DomainGrantDto>(`SELECT g.*,s.product_id,p.name AS product,s.name AS service,COALESCE(d.domain,'All domains (current and future)') AS domain FROM service_domain_grants g JOIN services s ON s.id=g.service_id JOIN products p ON p.id=s.product_id LEFT JOIN sending_domains d ON d.id=g.sending_domain_id ORDER BY p.name,s.name,d.domain NULLS FIRST`),
credentials: () => query<ServiceCredentialDto>(`SELECT c.id,c.key_prefix,c.status,c.created_at,c.valid_from,c.valid_to,c.last_used_at,s.name AS service,s.id AS service_id,p.name AS product
    FROM service_credentials c JOIN services s ON s.id=c.service_id JOIN products p ON p.id=s.product_id ORDER BY c.created_at DESC`)};

export async function activeServiceExists(id:string|null){return Boolean((await query<{id:string}>("SELECT s.id FROM services s JOIN products p ON p.id=s.product_id WHERE s.id=$1 AND p.status='active'",[id])).rowCount);}
