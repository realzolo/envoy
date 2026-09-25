import { hashApiKey } from "@/server/crypto";
import { query } from "@/server/database";
import { SERVICE_REQUESTS_PER_MINUTE } from "@/server/service-limits";

export type ServiceIdentity = {
  serviceId: string;
  serviceName: string;
  productId: string;
  product: string;
  rateLimitPerMinute: number;
};

export async function authenticateService(request: Request): Promise<ServiceIdentity | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;

  const suppliedKey = authorization.slice("Bearer ".length);
  if (suppliedKey.length < 12 || suppliedKey.length > 256) return null;

  const result = await query<{
    credential_id: string;
    id: string;
    name: string;
    product_id: string;
    product_name: string;
  }>(
    `SELECT c.id AS credential_id, s.id, s.name, s.product_id, p.name AS product_name
     FROM service_credentials c
     JOIN services s ON s.id = c.service_id
     JOIN products p ON p.id = s.product_id
     WHERE c.key_hash = $1 AND c.status = 'active' AND c.valid_from <= now()
       AND (c.valid_to IS NULL OR c.valid_to > now()) AND p.status = 'active'`,
    [hashApiKey(suppliedKey)],
  );

  const service = result.rows[0];
  if (!service) return null;

  void query("UPDATE service_credentials SET last_used_at = now() WHERE id = $1", [service.credential_id]);

  return {
    serviceId: service.id,
    serviceName: service.name,
    productId: service.product_id,
    product: service.product_name,
    rateLimitPerMinute: SERVICE_REQUESTS_PER_MINUTE,
  };
}
