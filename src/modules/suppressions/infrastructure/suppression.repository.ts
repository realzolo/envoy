import type { Pool, PoolClient } from "pg";
import { and, eq } from "drizzle-orm";
import { database, pool } from "@/platform/database";
import { auditLogs, products, suppressions } from "@/platform/database/schema";
import type { SuppressionRepository } from "../application/service";

export function suppressionRepository(client: Pool | PoolClient = pool()): SuppressionRepository {
  const orm = database(client);
  return {
    async list(productId, email) {
      const rows = (await client.query<{ id: string; scope_type: string; list_id: string | null; email_normalized: string; reason: string; source: string; expires_at: Date | null; created_at: Date }>(
        `SELECT id,scope_type,list_id,email_normalized,reason,source,expires_at,created_at FROM suppressions
         WHERE active=true AND (expires_at IS NULL OR expires_at>now())
           AND (($2::text IS NOT NULL AND email_normalized=lower($2) AND (scope_type='global' OR product_id=$1)) OR ($2::text IS NULL AND product_id=$1)) ORDER BY created_at DESC`, [productId, email ?? null])).rows;
      return rows.map(row => ({ id: row.id, scope: row.scope_type, listId: row.list_id, email: row.email_normalized, reason: row.reason, source: row.source, expiresAt: row.expires_at?.toISOString() ?? null, createdAt: row.created_at.toISOString() }));
    },
    async lockScope(input) { await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(["suppression", input.productId, input.scope, input.listId ?? null, input.email])]); },
    async existing(input) {
      return (await client.query<{ id: string }>(`SELECT id FROM suppressions WHERE active=true AND product_id=$1 AND scope_type=$2
        AND COALESCE(list_id,'')=COALESCE($3,'') AND email_normalized=$4 FOR UPDATE`, [input.productId, input.scope, input.listId ?? null, input.email])).rows[0]?.id ?? null;
    },
    async insert(id, input, source) { await orm.insert(suppressions).values({ id, scopeType: input.scope, productId: input.productId ?? null, listId: input.listId ?? null, emailNormalized: input.email.toLowerCase(), reason: input.reason, source, expiresAt: input.expiresAt ?? null }); },
    async productExists(id) { return !!(await orm.select({ id: products.id }).from(products).where(eq(products.id, id)).limit(1))[0]; },
    async deactivate(id, productId) {
      return (await orm.update(suppressions).set({ active: false, updatedAt: new Date().toISOString() }).where(and(eq(suppressions.id, id), productId ? and(eq(suppressions.productId, productId), eq(suppressions.active, true)) : undefined)).returning({ id: suppressions.id }))[0] ?? null;
    },
    async audit(actor, action, id, details = {}) { await orm.insert(auditLogs).values({ actor, action, resourceType: "suppression", resourceId: id, details }); },
  };
}
