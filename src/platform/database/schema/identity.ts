import { type PgTableExtraConfigValue, pgTable, unique, check, text, integer, timestamp, uniqueIndex, foreignKey, boolean } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm";

export const services = pgTable("services", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	status: text().default('active').notNull(),
	suppressionManagementAllowed: boolean("suppression_management_allowed").default(false).notNull(),
	configurationRevision: integer("configuration_revision").default(1).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	check("services_status_check", sql`status IN ('active', 'suspended')`),
	uniqueIndex("services_name_key").on(sql`lower(${table.name})`),
	check("services_configuration_revision_check", sql`configuration_revision > 0`),
]);


export const serviceCredentials = pgTable("service_credentials", {
	id: text().primaryKey().notNull(),
	serviceId: text("service_id").notNull(),
	keyPrefix: text("key_prefix").notNull(),
	keyHash: text("key_hash").notNull(),
	status: text().default('active').notNull(),
	validFrom: timestamp("valid_from", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	validTo: timestamp("valid_to", { withTimezone: true, mode: 'string' }),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.id],
			name: "service_credentials_service_id_fkey"
		}).onDelete("cascade"),
	unique("service_credentials_key_hash_key").on(table.keyHash),
	check("service_credentials_status_check", sql`status = ANY (ARRAY['active'::text, 'revoked'::text])`),
]);
