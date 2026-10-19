import { type PgTableExtraConfigValue, pgTable, unique, check, text, jsonb, integer, timestamp, foreignKey, boolean, index, primaryKey, bigint, uuid } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm";
import { services } from "./identity";
import { providerAccounts, providerIdentities, providerWebhookEndpoints, sendingDomains } from "./channels";
import { bytea } from "./types";

export const routingPolicies = pgTable("routing_policies", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	serviceScope: text("service_scope").default('all').notNull(),
	sendingDomainId: text("sending_domain_id").notNull(),
	messageCategory: text("message_category"),
	priority: integer().default(100).notNull(),
	status: text().default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	foreignKey({
			columns: [table.sendingDomainId],
			foreignColumns: [sendingDomains.id],
			name: "routing_policies_sending_domain_id_fkey"
		}).onDelete("restrict"),
	check("routing_policies_status_check", sql`status = ANY (ARRAY['active'::text, 'disabled'::text])`),
	check("routing_policies_service_scope_check", sql`service_scope IN ('all', 'selected')`),
]);


export const routingPolicyServices = pgTable("routing_policy_services", {
 policyId: text("policy_id").notNull().references(() => routingPolicies.id, { onDelete: "cascade" }),
 serviceId: text("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
}, table => [
 primaryKey({ columns: [table.policyId, table.serviceId] }),
 index("routing_policy_services_service_idx").on(table.serviceId),
]);

export const routingTargets = pgTable("routing_targets", {
	id: text().primaryKey().notNull(),
	policyId: text("policy_id").notNull(),
	providerAccountId: text("provider_account_id").notNull(),
	providerIdentityId: text("provider_identity_id").notNull(),
	priority: integer().default(100).notNull(),
	weight: integer().default(100).notNull(),
	rateLimitPerMinute: integer("rate_limit_per_minute").default(1000).notNull(),
	status: text().default('active').notNull(),
	circuitOpenUntil: timestamp("circuit_open_until", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	foreignKey({
			columns: [table.policyId],
			foreignColumns: [routingPolicies.id],
			name: "routing_targets_policy_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.providerAccountId],
			foreignColumns: [providerAccounts.id],
			name: "routing_targets_provider_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.providerIdentityId],
			foreignColumns: [providerIdentities.id],
			name: "routing_targets_provider_identity_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.providerIdentityId, table.providerAccountId],
			foreignColumns: [providerIdentities.id, providerIdentities.providerAccountId],
			name: "routing_targets_provider_identity_id_provider_account_id_fkey"
		}).onDelete("restrict"),
	unique("routing_targets_policy_id_provider_identity_id_key").on(table.policyId, table.providerIdentityId),
	check("routing_targets_weight_check", sql`weight > 0`),
	check("routing_targets_rate_limit_per_minute_check", sql`rate_limit_per_minute > 0`),
	check("routing_targets_status_check", sql`status = ANY (ARRAY['active'::text, 'circuit_open'::text])`),
]);


export const deliveries = pgTable("deliveries", {
	id: text().primaryKey().notNull(),
	messageId: text("message_id").notNull(),
	recipientEmail: text("recipient_email").notNull(),
	recipientName: text("recipient_name"),
	recipientRole: text("recipient_role").notNull(),
	lastError: jsonb("last_error"),
	lifecycleStatus: text("lifecycle_status").default('queued').notNull(),
	engagementStatus: text("engagement_status").default('unopened').notNull(),
	complianceStatus: text("compliance_status").default('clean').notNull(),
	currentAttemptId: text("current_attempt_id"),
	currentSubmissionId: text("current_submission_id"),
	queuedAt: timestamp("queued_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: 'string' }),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("deliveries_lifecycle_idx").using("btree", table.lifecycleStatus.asc().nullsLast(), table.queuedAt.desc().nullsFirst()),
	index("deliveries_message_status").using("btree", table.messageId.asc().nullsLast(), table.lifecycleStatus.asc().nullsLast()),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messages.id],
			name: "deliveries_message_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.currentSubmissionId],
			foreignColumns: [submissions.id],
			name: "deliveries_current_submission_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.currentAttemptId],
			foreignColumns: [submissionAttempts.id],
			name: "deliveries_current_attempt_fk"
		}).onDelete("set null"),
	unique("deliveries_message_id_recipient_email_key").on(table.messageId, table.recipientEmail),
	check("deliveries_recipient_role_check", sql`recipient_role = ANY (ARRAY['to'::text, 'cc'::text, 'bcc'::text])`),
	check("deliveries_lifecycle_status_check", sql`lifecycle_status = ANY (ARRAY['queued'::text, 'submitting'::text, 'accepted'::text, 'deferred'::text, 'delivered'::text, 'bounced'::text, 'failed'::text, 'unknown'::text, 'canceled'::text])`),
	check("deliveries_engagement_status_check", sql`engagement_status = ANY (ARRAY['unopened'::text, 'opened'::text, 'clicked'::text])`),
	check("deliveries_compliance_status_check", sql`compliance_status = ANY (ARRAY['clean'::text, 'complained'::text, 'unsubscribed'::text, 'suppressed'::text])`),
]);


export const messages = pgTable("messages", {
	contentPurgedAt: timestamp("content_purged_at", { withTimezone: true, mode: 'string' }),
	id: text().primaryKey().notNull(),
	serviceId: text("service_id").notNull(),
	sendingDomainId: text("sending_domain_id").notNull(),
	requestId: text("request_id"),
	toRecipients: jsonb("to_recipients").default([]).notNull(),
	ccRecipients: jsonb("cc_recipients").default([]).notNull(),
	bccRecipients: jsonb("bcc_recipients").default([]).notNull(),
	headers: jsonb().default({}).notNull(),
	inReplyTo: text("in_reply_to"),
	referencesIds: text("references_ids").array().default(sql`'{}'::text[]`).notNull(),
	attachmentSnapshot: jsonb("attachment_snapshot").default([]).notNull(),
	senderSnapshot: jsonb("sender_snapshot").notNull(),
	contentPolicy: text("content_policy").default('normal').notNull(),
	sendBefore: timestamp("send_before", { withTimezone: true, mode: 'string' }),
	sensitiveContent: jsonb("sensitive_content"),
	sensitiveContentPurgedAt: timestamp("sensitive_content_purged_at", { withTimezone: true, mode: 'string' }),
	idempotencyKey: text("idempotency_key").notNull(),
	payloadHash: text("payload_hash").notNull(),
	payloadHashKeyVersion: text("payload_hash_key_version"),
	referenceId: text("reference_id"),
	metadata: jsonb().default({}).notNull(),
	recipientCount: integer("recipient_count").notNull(),
	subject: text().notNull(),
	htmlBody: text("html_body"),
	textBody: text("text_body"),
	messageCategory: text("message_category").notNull(),
	replyTo: jsonb("reply_to").default([]).notNull(),
	providerTags: jsonb("provider_tags").default({}).notNull(),
	acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("messages_sensitive_expiry_idx").using("btree", table.sendBefore.asc().nullsLast()).where(sql`(sensitive_content IS NOT NULL)`),
	index("messages_service_accepted_cursor").using("btree", table.serviceId.asc().nullsLast(), table.acceptedAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
	foreignKey({
			columns: [table.serviceId],
			foreignColumns: [services.id],
			name: "messages_service_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.sendingDomainId],
			foreignColumns: [sendingDomains.id],
			name: "messages_sending_domain_id_fkey"
		}).onDelete("restrict"),
	unique("messages_service_id_idempotency_key_key").on(table.serviceId, table.idempotencyKey),
	check("messages_content_policy_check", sql`content_policy = ANY (ARRAY['normal'::text, 'sensitive'::text])`),
	check("messages_recipient_count_check", sql`recipient_count > 0`),
	check("messages_check", sql`(content_policy = 'sensitive'::text) OR (html_body IS NOT NULL) OR (text_body IS NOT NULL)`),
	check("messages_check1", sql`(content_policy <> 'sensitive'::text) OR (content_purged_at IS NOT NULL) OR ((send_before IS NOT NULL) AND (html_body IS NULL) AND (text_body IS NULL) AND (subject = '[Sensitive content]'::text) AND (metadata = '{}'::jsonb) AND (headers = '{}'::jsonb) AND (provider_tags = '{}'::jsonb))`),
	check("messages_check2", sql`(content_policy = 'sensitive'::text) OR (sensitive_content IS NULL)`),
]);


export const submissions = pgTable("submissions", {
	id: text().primaryKey().notNull(),
	messageId: text("message_id").notNull(),
	status: text().default('queued').notNull(),
	currentAttemptId: text("current_attempt_id"),
	deferCount: integer("defer_count").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("submissions_message").using("btree", table.messageId.asc().nullsLast()),
	index("submissions_recovery").using("btree", table.status.asc().nullsLast(), table.updatedAt.asc().nullsLast()).where(sql`(status = ANY (ARRAY['queued'::text, 'deferred'::text, 'submitting'::text, 'unknown'::text]))`),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messages.id],
			name: "submissions_message_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.currentAttemptId],
			foreignColumns: [submissionAttempts.id],
			name: "submissions_current_attempt_fk"
		}).onDelete("set null"),
	check("submissions_status_check", sql`status = ANY (ARRAY['queued'::text, 'submitting'::text, 'accepted'::text, 'deferred'::text, 'unknown'::text, 'failed'::text, 'canceled'::text])`),
	check("submissions_defer_count_check", sql`defer_count >= 0`),
]);


export const submissionAttempts = pgTable("submission_attempts", {
	id: text().primaryKey().notNull(),
	submissionId: text("submission_id").notNull(),
	attemptNumber: integer("attempt_number").notNull(),
	providerAccountId: text("provider_account_id").notNull(),
	providerIdentityId: text("provider_identity_id").notNull(),
	routingSnapshot: jsonb("routing_snapshot").notNull(),
	requestFingerprint: text("request_fingerprint").notNull(),
	providerIdempotencyKey: text("provider_idempotency_key"),
	externalMessageId: text("external_message_id"),
	rfcMessageId: text("rfc_message_id"),
	status: text().notNull(),
	outcomeDeterminate: boolean("outcome_determinate").default(false).notNull(),
	errorCategory: text("error_category"),
	errorCode: text("error_code"),
	errorMessage: text("error_message"),
	diagnostic: jsonb(),
	providerResponseRef: text("provider_response_ref"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	submissionDeadlineAt: timestamp("submission_deadline_at", { withTimezone: true, mode: 'string' }).default(sql`(now() + '00:02:00'::interval)`).notNull(),
	retryAuthorizedAt: timestamp("retry_authorized_at", { withTimezone: true, mode: 'string' }),
	retryAuthorizedBy: text("retry_authorized_by"),
	reconciliationCount: integer("reconciliation_count").default(0).notNull(),
	reconcileAfter: timestamp("reconcile_after", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("attempts_external_idx").using("btree", table.providerAccountId.asc().nullsLast(), table.externalMessageId.asc().nullsLast()),
	index("attempts_reconcile_due").using("btree", table.reconcileAfter.asc().nullsLast()).where(sql`(status = ANY (ARRAY['unknown'::text, 'reconciling'::text]))`),
	index("provider_attempt_usage").using("btree", table.providerAccountId.asc().nullsLast(), table.startedAt.asc().nullsLast()),
	foreignKey({
			columns: [table.submissionId],
			foreignColumns: [submissions.id],
			name: "submission_attempts_submission_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.providerAccountId],
			foreignColumns: [providerAccounts.id],
			name: "submission_attempts_provider_account_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.providerIdentityId],
			foreignColumns: [providerIdentities.id],
			name: "submission_attempts_provider_identity_id_fkey"
		}).onDelete("restrict"),
	unique("submission_attempts_submission_id_attempt_number_key").on(table.submissionId, table.attemptNumber),
	unique("submission_attempts_provider_account_id_external_message_id_key").on(table.providerAccountId, table.externalMessageId),
	check("submission_attempts_attempt_number_check", sql`attempt_number > 0`),
	check("submission_attempts_status_check", sql`status = ANY (ARRAY['submitting'::text, 'accepted'::text, 'failed'::text, 'unknown'::text, 'reconciling'::text, 'reconciled'::text])`),
	check("submission_attempts_reconciliation_count_check", sql`reconciliation_count >= 0`),
]);


export const deliveryEvents = pgTable("delivery_events", {
	id: text().primaryKey().notNull(),
	deliveryId: text("delivery_id").notNull(),
	rawProviderEventId: text("raw_provider_event_id"),
	eventType: text("event_type").notNull(),
	sourceKey: text("source_key").notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).notNull(),
	canonicalPayload: jsonb("canonical_payload").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("delivery_events_delivery_occurred_cursor").using("btree", table.deliveryId.asc().nullsLast(), table.occurredAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
	index("delivery_events_timeline_idx").using("btree", table.deliveryId.asc().nullsLast(), table.occurredAt.desc().nullsFirst()),
	foreignKey({
			columns: [table.deliveryId],
			foreignColumns: [deliveries.id],
			name: "delivery_events_delivery_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.rawProviderEventId],
			foreignColumns: [rawProviderEvents.id],
			name: "delivery_events_raw_provider_event_id_fkey"
		}).onDelete("set null"),
	unique("delivery_events_source_key_key").on(table.sourceKey),
]);


export const submissionEvents = pgTable("submission_events", {
	id: text().primaryKey().notNull(),
	submissionId: text("submission_id").notNull(),
	rawProviderEventId: text("raw_provider_event_id"),
	attemptId: text("attempt_id"),
	eventType: text("event_type").notNull(),
	sourceKey: text("source_key").notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).notNull(),
	canonicalPayload: jsonb("canonical_payload").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("submission_events_evidence").using("btree", table.submissionId.asc().nullsLast(), table.eventType.asc().nullsLast(), table.occurredAt.desc().nullsFirst()),
	index("submission_events_raw_event_idx").using("btree", table.rawProviderEventId.asc().nullsLast()).where(sql`(raw_provider_event_id IS NOT NULL)`),
	index("submission_events_timeline").using("btree", table.submissionId.asc().nullsLast(), table.occurredAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
	foreignKey({
			columns: [table.submissionId],
			foreignColumns: [submissions.id],
			name: "submission_events_submission_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.attemptId],
			foreignColumns: [submissionAttempts.id],
			name: "submission_events_attempt_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.rawProviderEventId],
			foreignColumns: [rawProviderEvents.id],
			name: "submission_events_raw_event_fk"
		}).onDelete("set null"),
	unique("submission_events_source_key_key").on(table.sourceKey),
]);


export const rawProviderEvents = pgTable("raw_provider_events", {
	contentPurgedAt: timestamp("content_purged_at", { withTimezone: true, mode: 'string' }),
	id: text().primaryKey().notNull(),
	providerAccountId: text("provider_account_id").notNull(),
	webhookEndpointId: text("webhook_endpoint_id").notNull(),
	providerEventId: text("provider_event_id"),
	nativeType: text("native_type").notNull(),
	signatureValid: boolean("signature_valid").notNull(),
	replayValid: boolean("replay_valid").notNull(),
	payloadExpiresAt: timestamp("payload_expires_at", { withTimezone: true, mode: 'string' }),
	rawPayloadPurgedAt: timestamp("raw_payload_purged_at", { withTimezone: true, mode: 'string' }),
	normalizedEvents: jsonb("normalized_events"),
	rawBody: bytea("raw_body"),
	rawObjectKey: text("raw_object_key"),
	headers: jsonb().notNull(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'string' }),
	terminatedAt: timestamp("terminated_at", { withTimezone: true, mode: 'string' }),
	processingError: text("processing_error"),
	verification: jsonb(),
	securityVersion: integer("security_version").default(0).notNull(),
	processingAttemptCount: integer("processing_attempt_count").default(0).notNull(),
	nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("raw_events_retry_due").using("btree", table.nextAttemptAt.asc().nullsLast()).where(sql`(processed_at IS NULL)`),
	index("raw_provider_events_pending_idx").using("btree", table.processedAt.asc().nullsLast(), table.receivedAt.asc().nullsLast()),
	foreignKey({
			columns: [table.providerAccountId],
			foreignColumns: [providerAccounts.id],
			name: "raw_provider_events_provider_account_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.webhookEndpointId],
			foreignColumns: [providerWebhookEndpoints.id],
			name: "raw_provider_events_webhook_endpoint_id_fkey"
		}).onDelete("restrict"),
	unique("raw_provider_events_provider_account_id_provider_event_id_key").on(table.providerAccountId, table.providerEventId),
	check("raw_provider_events_processing_attempt_count_check", sql`processing_attempt_count >= 0`),
]);


export const submissionDeliveries = pgTable("submission_deliveries", {
	submissionId: text("submission_id").notNull(),
	deliveryId: text("delivery_id").notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("submission_deliveries_delivery").using("btree", table.deliveryId.asc().nullsLast()),
	foreignKey({
			columns: [table.submissionId],
			foreignColumns: [submissions.id],
			name: "submission_deliveries_submission_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.deliveryId],
			foreignColumns: [deliveries.id],
			name: "submission_deliveries_delivery_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.submissionId, table.deliveryId], name: "submission_deliveries_pkey"}),
]);


export const messageRetries = pgTable("message_retries", {
	messageId: text("message_id").notNull(),
	idempotencyKey: text("idempotency_key").notNull(),
	payloadHash: text("payload_hash").notNull(),
	result: jsonb().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messages.id],
			name: "message_retries_message_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.messageId, table.idempotencyKey], name: "message_retries_pkey"}),
]);


export const outboundStreams = pgTable("outbound_streams", {
  serviceId: text("service_id").primaryKey().notNull().references(() => services.id, { onDelete: "cascade" }),
  generation: uuid().defaultRandom().notNull(),
  position: bigint({ mode: "bigint" }).default(sql`0`).notNull(),
  floor: bigint({ mode: "bigint" }).default(sql`0`).notNull(),
});

export const outboundChanges = pgTable("outbound_changes", {
  serviceId: text("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  position: bigint({ mode: "bigint" }).notNull(),
  id: text().notNull(),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  type: text().notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "string" }).default(sql`clock_timestamp()`).notNull(),
}, table => [primaryKey({ columns: [table.serviceId, table.position] }), unique().on(table.id)]);
