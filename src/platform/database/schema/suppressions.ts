import { type PgTableExtraConfigValue, pgTable, check, text, integer, timestamp, uniqueIndex, foreignKey, boolean } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm";
import { products } from "./identity";

export const suppressions = pgTable("suppressions", {
	id: text().primaryKey().notNull(),
	scopeType: text("scope_type").notNull(),
	productId: text("product_id"),
	listId: text("list_id"),
	emailNormalized: text("email_normalized").notNull(),
	reason: text().notNull(),
	source: text().notNull(),
	bounceCount: integer("bounce_count").default(0).notNull(),
	active: boolean().default(true).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	uniqueIndex("suppressions_active_scope").using("btree", sql`scope_type`, sql`COALESCE(product_id, '*'::text)`, sql`COALESCE(list_id, '*'::text)`, sql`email_normalized`).where(sql`(active = true)`),
	foreignKey({
			columns: [table.productId],
			foreignColumns: [products.id],
			name: "suppressions_product_id_fkey"
		}).onDelete("cascade"),
	check("suppressions_scope_type_check", sql`scope_type = ANY (ARRAY['global'::text, 'product'::text, 'list'::text])`),
	check("suppressions_check", sql`((scope_type = 'global'::text) AND (product_id IS NULL) AND (list_id IS NULL)) OR ((scope_type = 'product'::text) AND (product_id IS NOT NULL) AND (list_id IS NULL)) OR ((scope_type = 'list'::text) AND (product_id IS NOT NULL) AND (list_id IS NOT NULL))`),
	check("suppressions_email_normalized_check", sql`email_normalized = lower(email_normalized)`),
]);

