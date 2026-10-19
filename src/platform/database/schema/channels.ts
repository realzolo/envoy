import { type PgTableExtraConfigValue, pgTable, unique, check, text, jsonb, integer, timestamp, uniqueIndex, foreignKey, boolean } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm";

export const providerAccounts = pgTable("provider_accounts", {
	id: text().primaryKey().notNull(),
	type: text().notNull(),
	name: text().notNull(),
	status: text().default('degraded').notNull(),
	publicConfig: jsonb("public_config").notNull(),
	configSchemaVersion: integer("config_schema_version").default(1).notNull(),
	health: jsonb().default({"status":"unknown"}).notNull(),
	quota: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	unique("provider_accounts_name_key").on(table.name),
	check("provider_accounts_type_check", sql`type = ANY (ARRAY['resend'::text, 'ses'::text, 'sendgrid'::text, 'mailgun'::text, 'postmark'::text, 'mock'::text])`),
	check("provider_accounts_status_check", sql`status = ANY (ARRAY['active'::text, 'disabled'::text, 'degraded'::text])`),
]);


export const providerCredentials = pgTable("provider_credentials", {
	id: text().primaryKey().notNull(),
	providerAccountId: text("provider_account_id").notNull(),
	credentialVersion: integer("credential_version").notNull(),
	secretCiphertext: text("secret_ciphertext").notNull(),
	encryptedDek: text("encrypted_dek").notNull(),
	keyVersion: text("key_version").notNull(),
	status: text().default('active').notNull(),
	validFrom: timestamp("valid_from", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	validTo: timestamp("valid_to", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdBy: text("created_by").notNull(),
}, (table): PgTableExtraConfigValue[] => [
	uniqueIndex("provider_credentials_one_active").using("btree", table.providerAccountId.asc().nullsLast()).where(sql`(status = 'active'::text)`),
	foreignKey({
			columns: [table.providerAccountId],
			foreignColumns: [providerAccounts.id],
			name: "provider_credentials_provider_account_id_fkey"
		}).onDelete("cascade"),
	unique("provider_credentials_provider_account_id_credential_version_key").on(table.providerAccountId, table.credentialVersion),
	check("provider_credentials_credential_version_check", sql`credential_version > 0`),
	check("provider_credentials_status_check", sql`status = ANY (ARRAY['active'::text, 'revoked'::text])`),
]);


export const providerWebhookEndpoints = pgTable("provider_webhook_endpoints", {
	id: text().primaryKey().notNull(),
	providerAccountId: text("provider_account_id").notNull(),
	opaqueToken: text("opaque_token").notNull(),
	securityConfigCiphertext: text("security_config_ciphertext"),
	securityEncryptedDek: text("security_encrypted_dek"),
	keyVersion: text("key_version"),
	securityVersion: integer("security_version").default(0).notNull(),
	securityConfigured: boolean("security_configured").default(false).notNull(),
	status: text().default('active').notNull(),
	expectedTopicArn: text("expected_topic_arn"),
	ipAllowlist: text("ip_allowlist").array().default(sql`'{}'::text[]`).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	foreignKey({
			columns: [table.providerAccountId],
			foreignColumns: [providerAccounts.id],
			name: "provider_webhook_endpoints_provider_account_id_fkey"
		}).onDelete("cascade"),
	unique("provider_webhook_endpoints_provider_account_id_key").on(table.providerAccountId),
	unique("provider_webhook_endpoints_opaque_token_key").on(table.opaqueToken),
	check("provider_webhook_endpoints_status_check", sql`status = ANY (ARRAY['active'::text, 'disabled'::text])`),
]);


export const sendingDomains = pgTable("sending_domains", {
	id: text().primaryKey().notNull(),
	domain: text().notNull(),
	status: text().default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	unique("sending_domains_domain_key").on(table.domain),
	check("sending_domains_status_check", sql`status = ANY (ARRAY['active'::text, 'disabled'::text])`),
]);


export const providerIdentities = pgTable("provider_identities", {
	id: text().primaryKey().notNull(),
	sendingDomainId: text("sending_domain_id").notNull(),
	providerAccountId: text("provider_account_id").notNull(),
	externalIdentityId: text("external_identity_id"),
	status: text().default('pending').notNull(),
	dnsRecords: jsonb("dns_records").default([]).notNull(),
	lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	foreignKey({
			columns: [table.sendingDomainId],
			foreignColumns: [sendingDomains.id],
			name: "provider_identities_sending_domain_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.providerAccountId],
			foreignColumns: [providerAccounts.id],
			name: "provider_identities_provider_account_id_fkey"
		}).onDelete("cascade"),
	unique("provider_identities_id_provider_account_id_key").on(table.id, table.providerAccountId),
	unique("provider_identities_id_sending_domain_id_key").on(table.id, table.sendingDomainId),
	unique("provider_identities_sending_domain_id_provider_account_id_key").on(table.sendingDomainId, table.providerAccountId),
	check("provider_identities_status_check", sql`status = ANY (ARRAY['pending'::text, 'verified'::text, 'failed'::text, 'disabled'::text])`),
]);

