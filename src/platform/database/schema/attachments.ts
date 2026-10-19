import { type PgTableExtraConfigValue, pgTable, unique, check, text, integer, timestamp, foreignKey, bigint, index } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm";
import { services } from "./identity";
import { sendingDomains } from "./channels";
import { inboundMessages } from "./inbound";

export const outboundFiles = pgTable("outbound_files", {
	id: text().primaryKey().notNull(),
	serviceId: text("service_id").notNull(),
	sendingDomainId: text("sending_domain_id").notNull(),
	fileName: text("file_name").notNull(),
	contentType: text("content_type").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
	sha256: text().notNull(),
	objectKey: text("object_key").notNull(),
	contentPurgedAt: timestamp("content_purged_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.id],
			name: "outbound_files_service_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.sendingDomainId],
			foreignColumns: [sendingDomains.id],
			name: "outbound_files_sending_domain_id_fkey"
		}).onDelete("restrict"),
	unique("outbound_files_object_key_key").on(table.objectKey),
	check("outbound_files_size_bytes_check", sql`size_bytes > 0`),
]);


export const inboundAttachments = pgTable("inbound_attachments", {
	contentPurgedAt: timestamp("content_purged_at", { withTimezone: true, mode: 'string' }),
	id: text().primaryKey().notNull(),
	inboundMessageId: text("inbound_message_id").notNull(),
	fileName: text("file_name").notNull(),
	contentType: text("content_type").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
	objectKey: text("object_key").notNull(),
	contentId: text("content_id"),
	sha256: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	foreignKey({
			columns: [table.inboundMessageId],
			foreignColumns: [inboundMessages.id],
			name: "inbound_attachments_inbound_message_id_fkey"
		}).onDelete("cascade"),
]);


export const pendingObjectDeletions = pgTable("pending_object_deletions", {
	objectKey: text("object_key").primaryKey().notNull(),
	availableAt: timestamp("available_at", { withTimezone: true, mode: 'string' }).default(sql`(now() + '00:10:00'::interval)`).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastError: text("last_error"),
	attemptCount: integer("attempt_count").default(0).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("pending_object_deletions_due").using("btree", table.availableAt.asc().nullsLast()),
	check("pending_object_deletions_attempt_count_check", sql`attempt_count >= 0`),
]);


export const attachmentSafety = pgTable("attachment_safety", {
	resourceId: text("resource_id").primaryKey().notNull(),
	kind: text().notNull(),
	serviceId: text("service_id"),
	scope: text().notNull(),
	expectedSha256: text("expected_sha256").notNull(),
	scannedSha256: text("scanned_sha256"),
	policyVersion: text("policy_version"),
	status: text().default('pending').notNull(),
	reason: text(),
	attemptCount: integer("attempt_count").default(0).notNull(),
	nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	queuedUntil: timestamp("queued_until", { withTimezone: true, mode: 'string' }),
	outboxId: text("outbox_id"),
	leaseToken: text("lease_token"),
	leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: 'string' }),
	checkedAt: timestamp("checked_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("attachment_safety_due").using("btree", table.scope.asc().nullsLast(), table.nextAttemptAt.asc().nullsLast(), table.resourceId.asc().nullsLast()).where(sql`(status <> ALL (ARRAY['malicious'::text, 'blocked'::text, 'purged'::text]))`),
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.id],
			name: "attachment_safety_service_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.scope],
			foreignColumns: [attachmentScanScopes.scope],
			name: "attachment_safety_scope_fkey"
		}),
	check("attachment_safety_kind_check", sql`kind = ANY (ARRAY['outbound'::text, 'inbound'::text])`),
	check("attachment_safety_status_check", sql`status = ANY (ARRAY['pending'::text, 'scanning'::text, 'clean'::text, 'verified'::text, 'malicious'::text, 'unavailable'::text, 'blocked'::text, 'purged'::text])`),
]);


export const attachmentScanScopes = pgTable("attachment_scan_scopes", {
	scope: text().primaryKey().notNull(),
	lastDispatchedAt: timestamp("last_dispatched_at", { withTimezone: true, mode: 'string' }).default(sql`'-infinity'`).notNull(),
});

