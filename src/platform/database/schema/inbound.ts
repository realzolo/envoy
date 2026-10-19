import { type PgTableExtraConfigValue, pgTable, unique, check, text, jsonb, timestamp, uniqueIndex, foreignKey, bigint, index, uuid, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm";
import { services } from "./identity";
import { providerAccounts, providerWebhookEndpoints, sendingDomains } from "./channels";
import { rawProviderEvents } from "./outbound";

export const inboundRoutes = pgTable("inbound_routes", {
	id: text().primaryKey().notNull(),
	providerWebhookEndpointId: text("provider_webhook_endpoint_id").notNull(),
	sendingDomainId: text("sending_domain_id").notNull(),
	serviceId: text("service_id").notNull(),
	status: text().default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	uniqueIndex("inbound_route_scope").using("btree", table.providerWebhookEndpointId.asc().nullsLast(), table.sendingDomainId.asc().nullsLast(), table.serviceId.asc().nullsLast()),
	foreignKey({
			columns: [table.providerWebhookEndpointId],
			foreignColumns: [providerWebhookEndpoints.id],
			name: "inbound_routes_provider_webhook_endpoint_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sendingDomainId],
			foreignColumns: [sendingDomains.id],
			name: "inbound_routes_sending_domain_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.id],
			name: "inbound_routes_service_id_fkey"
		}).onDelete("cascade"),
	check("inbound_routes_status_check", sql`status = ANY (ARRAY['active'::text, 'disabled'::text])`),
]);


export const inboundMessages = pgTable("inbound_messages", {
	contentPurgedAt: timestamp("content_purged_at", { withTimezone: true, mode: 'string' }),
	id: text().primaryKey().notNull(),
	inboundRouteId: text("inbound_route_id"),
	serviceId: text("service_id"),
	providerAccountId: text("provider_account_id").notNull(),
	rawProviderEventId: text("raw_provider_event_id"),
	externalMessageId: text("external_message_id"),
	messageId: text("message_id"),
	deliveryScope: text("delivery_scope").default('quarantine').notNull(),
	envelopeRecipients: text("envelope_recipients").array().default(sql`'{}'::text[]`).notNull(),
	replyTo: text("reply_to").array().default(sql`'{}'::text[]`).notNull(),
	inReplyTo: text("in_reply_to"),
	referencesIds: text("references_ids").array().default(sql`'{}'::text[]`).notNull(),
	fromEmail: text("from_email").notNull(),
	toEmails: text("to_emails").array().notNull(),
	ccEmails: text("cc_emails").array().default(sql`'{}'::text[]`).notNull(),
	bccEmails: text("bcc_emails").array().default(sql`'{}'::text[]`).notNull(),
	subject: text().notNull(),
	sanitizedHtml: text("sanitized_html"),
	textBody: text("text_body"),
	rawMimeObjectKey: text("raw_mime_object_key"),
	status: text().default('scanning').notNull(),
	rejectionReason: text("rejection_reason"),
	processingToken: text("processing_token"),
	processingDeadlineAt: timestamp("processing_deadline_at", { withTimezone: true, mode: 'string' }),
	authorDate: timestamp("author_date", { withTimezone: true, mode: 'string' }),
	ingressReceivedAt: timestamp("ingress_received_at", { withTimezone: true, mode: 'string' }),
	readyAt: timestamp("ready_at", { withTimezone: true, mode: 'string' }),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("inbound_evidence").using("btree", table.serviceId.asc().nullsLast(), table.providerAccountId.asc().nullsLast(), table.createdAt.desc().nullsFirst()).where(sql`(status = 'ready'::text)`),
	index("inbound_messages_received_idx").using("btree", table.receivedAt.desc().nullsFirst()),
	index("inbound_messages_service_received_cursor").using("btree", table.serviceId.asc().nullsLast(), table.receivedAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
	index("inbound_messages_service_stored_cursor").using("btree", table.serviceId.asc().nullsLast(), table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
	index("inbound_scan_due").using("btree", table.processingDeadlineAt.asc().nullsLast()).where(sql`(status = 'scanning'::text)`),
	foreignKey({
			columns: [table.inboundRouteId],
			foreignColumns: [inboundRoutes.id],
			name: "inbound_messages_inbound_route_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.id],
			name: "inbound_messages_service_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.providerAccountId],
			foreignColumns: [providerAccounts.id],
			name: "inbound_messages_provider_account_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.rawProviderEventId],
			foreignColumns: [rawProviderEvents.id],
			name: "inbound_messages_raw_provider_event_id_fkey"
		}).onDelete("set null"),
	unique("inbound_messages_provider_account_id_external_message_id_de_key").on(table.providerAccountId, table.externalMessageId, table.deliveryScope),
	check("inbound_messages_status_check", sql`status = ANY (ARRAY['scanning'::text, 'ready'::text, 'rejected'::text])`),
]);


export const inboundStreams = pgTable("inbound_streams", {
	serviceId: text("service_id").primaryKey().notNull(),
	generation: uuid().defaultRandom().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	position: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	floor: bigint({ mode: "number" }).default(0).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.id],
			name: "inbound_streams_service_id_fkey"
		}).onDelete("cascade"),
]);


export const inboundReceipts = pgTable("inbound_receipts", {
	providerAccountId: text("provider_account_id").notNull(),
	externalMessageId: text("external_message_id").notNull(),
	routes: jsonb().notNull(),
	terminatedAt: timestamp("terminated_at", { withTimezone: true, mode: 'string' }),
	ingressReceivedAt: timestamp("ingress_received_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	foreignKey({
			columns: [table.providerAccountId],
			foreignColumns: [providerAccounts.id],
			name: "inbound_receipts_provider_account_id_fkey"
		}),
	primaryKey({ columns: [table.providerAccountId, table.externalMessageId], name: "inbound_receipts_pkey"}),
]);


export const inboundChanges = pgTable("inbound_changes", {
	serviceId: text("service_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	position: bigint({ mode: "number" }).notNull(),
	id: text().default(sql`(\'ich_\'::text || (gen_random_uuid())::text)`).notNull(),
	inboundMessageId: text("inbound_message_id").notNull(),
	type: text().notNull(),
	recordedAt: timestamp("recorded_at", { withTimezone: true, mode: 'string' }).default(sql`clock_timestamp()`).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.id],
			name: "inbound_changes_service_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.inboundMessageId],
			foreignColumns: [inboundMessages.id],
			name: "inbound_changes_inbound_message_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.serviceId, table.position], name: "inbound_changes_pkey"}),
	unique("inbound_changes_id_key").on(table.id),
	check("inbound_changes_type_check", sql`type = ANY (ARRAY['inbound.available'::text, 'inbound.content_purged'::text])`),
]);
