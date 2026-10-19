import { type PgTableExtraConfigValue, pgTable, unique, check, text, jsonb, integer, timestamp, foreignKey, bigint, index, bigserial, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm";
import { services } from "./identity";
import { messages } from "./outbound";

export const outboxEvents = pgTable("outbox_events", {
	id: text().primaryKey().notNull(),
	aggregateType: text("aggregate_type").notNull(),
	aggregateId: text("aggregate_id").notNull(),
	eventType: text("event_type").notNull(),
	payload: jsonb().notNull(),
	status: text().default('pending').notNull(),
	attemptCount: integer("attempt_count").default(0).notNull(),
	availableAt: timestamp("available_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("outbox_pending_idx").using("btree", table.status.asc().nullsLast(), table.availableAt.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	check("outbox_events_status_check", sql`status = ANY (ARRAY['pending'::text, 'published'::text, 'failed'::text])`),
]);


export const auditLogs = pgTable("audit_logs", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	actor: text().notNull(),
	action: text().notNull(),
	resourceType: text("resource_type").notNull(),
	resourceId: text("resource_id"),
	details: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});


export const requestLogs = pgTable("request_logs", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	requestId: text("request_id").notNull(),
	serviceId: text("service_id"),
	messageId: text("message_id"),
	method: text().notNull(),
	path: text().notNull(),
	statusCode: integer("status_code").notNull(),
	durationMs: integer("duration_ms").notNull(),
	actor: text(),
	details: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("request_logs_created_idx").using("btree", table.createdAt.desc().nullsFirst()),
	index("request_logs_service").using("btree", table.serviceId.asc().nullsLast(), table.createdAt.desc().nullsFirst()),
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.id],
			name: "request_logs_service_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messages.id],
			name: "request_logs_message_id_fkey"
		}).onDelete("set null"),
	unique("request_logs_request_id_key").on(table.requestId),
]);


export const workerHeartbeats = pgTable("worker_heartbeats", {
	workerId: text("worker_id").primaryKey().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("worker_heartbeat_recency").using("btree", table.lastSeenAt.asc().nullsLast()),
]);


export const rateLimitCounters = pgTable("rate_limit_counters", {
	scope: text().notNull(),
	key: text().notNull(),
	windowStart: timestamp("window_start", { withTimezone: true, mode: 'string' }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	count: bigint({ mode: "number" }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("rate_limit_expiry").using("btree", table.expiresAt.asc().nullsLast()),
	primaryKey({ columns: [table.scope, table.key, table.windowStart], name: "rate_limit_counters_pkey"}),
	check("rate_limit_counters_count_check", sql`count >= 0`),
]);

