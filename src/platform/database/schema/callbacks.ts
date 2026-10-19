import { type PgTableExtraConfigValue, pgTable, check, text, jsonb, integer, timestamp, uniqueIndex, foreignKey, index } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm";
import { services } from "./identity";
import { deliveryEvents, submissionEvents } from "./outbound";
import { inboundMessages } from "./inbound";

export const callbackEndpoints = pgTable("callback_endpoints", {
	id: text().primaryKey().notNull(),
	serviceId: text("service_id").notNull(),
	name: text().notNull(),
	url: text(),
	secretCiphertext: text("secret_ciphertext").notNull(),
	encryptedDek: text("encrypted_dek").notNull(),
	keyVersion: text("key_version").notNull(),
	subscribedEvents: text("subscribed_events").array().notNull(),
	status: text().default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	uniqueIndex("callback_one_per_service").using("btree", table.serviceId.asc().nullsLast()),
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.id],
			name: "callback_endpoints_service_id_fkey"
		}).onDelete("cascade"),
	check("callback_endpoints_status_check", sql`status = ANY (ARRAY['active'::text, 'disabled'::text])`),
	check("callback_url_nonempty", sql`(url IS NULL) OR (url <> ''::text)`),
	check("active_callback_requires_url", sql`(status <> 'active'::text) OR (url IS NOT NULL)`),
]);


export const callbackDeliveries = pgTable("callback_deliveries", {
	payloadPurgedAt: timestamp("payload_purged_at", { withTimezone: true, mode: 'string' }),
	id: text().primaryKey().notNull(),
	endpointId: text("endpoint_id").notNull(),
	deliveryEventId: text("delivery_event_id"),
	submissionEventId: text("submission_event_id"),
	inboundMessageId: text("inbound_message_id"),
	eventType: text("event_type").notNull(),
	payload: jsonb().notNull(),
	status: text().default('pending').notNull(),
	attemptCount: integer("attempt_count").default(0).notNull(),
	responseCode: integer("response_code"),
	lastError: text("last_error"),
	nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: 'string' }),
	terminatedAt: timestamp("terminated_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("callback_deliveries_pending_idx").using("btree", table.status.asc().nullsLast(), table.nextAttemptAt.asc().nullsLast()),
	uniqueIndex("callback_delivery_event_once").using("btree", table.endpointId.asc().nullsLast(), table.deliveryEventId.asc().nullsLast()).where(sql`(delivery_event_id IS NOT NULL)`),
	uniqueIndex("callback_inbound_event_once").using("btree", table.endpointId.asc().nullsLast(), table.inboundMessageId.asc().nullsLast(), table.eventType.asc().nullsLast()).where(sql`(inbound_message_id IS NOT NULL)`),
	uniqueIndex("callback_submission_event_once").using("btree", table.endpointId.asc().nullsLast(), table.submissionEventId.asc().nullsLast()).where(sql`(submission_event_id IS NOT NULL)`),
	foreignKey({
			columns: [table.endpointId],
			foreignColumns: [callbackEndpoints.id],
			name: "callback_deliveries_endpoint_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.deliveryEventId],
			foreignColumns: [deliveryEvents.id],
			name: "callback_deliveries_delivery_event_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.submissionEventId],
			foreignColumns: [submissionEvents.id],
			name: "callback_deliveries_submission_event_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.inboundMessageId],
			foreignColumns: [inboundMessages.id],
			name: "callback_deliveries_inbound_message_id_fkey"
		}).onDelete("set null"),
	check("callback_deliveries_status_check", sql`status = ANY (ARRAY['pending'::text, 'delivering'::text, 'delivered'::text, 'retrying'::text, 'dead_letter'::text, 'terminated'::text])`),
]);

