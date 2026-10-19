-- Envoy application schema, generated from typed Drizzle definitions.
-- This snapshot is checked against the cumulative ordered migrations.
-- ALTER statements below declare final foreign keys, including circular references.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE "service_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_credentials_key_hash_key" UNIQUE("key_hash"),
	CONSTRAINT "service_credentials_status_check" CHECK (status = ANY (ARRAY['active'::text, 'revoked'::text]))
);

CREATE TABLE "services" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"suppression_management_allowed" boolean DEFAULT false NOT NULL,
	"configuration_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_status_check" CHECK (status IN ('active', 'suspended')),
	CONSTRAINT "services_configuration_revision_check" CHECK (configuration_revision > 0)
);

CREATE TABLE "provider_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'degraded' NOT NULL,
	"public_config" jsonb NOT NULL,
	"config_schema_version" integer DEFAULT 1 NOT NULL,
	"health" jsonb DEFAULT '{"status":"unknown"}'::jsonb NOT NULL,
	"quota" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_accounts_name_key" UNIQUE("name"),
	CONSTRAINT "provider_accounts_type_check" CHECK (type = ANY (ARRAY['resend'::text, 'ses'::text, 'sendgrid'::text, 'mailgun'::text, 'postmark'::text, 'mock'::text])),
	CONSTRAINT "provider_accounts_status_check" CHECK (status = ANY (ARRAY['active'::text, 'disabled'::text, 'degraded'::text]))
);

CREATE TABLE "provider_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_account_id" text NOT NULL,
	"credential_version" integer NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"encrypted_dek" text NOT NULL,
	"key_version" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "provider_credentials_provider_account_id_credential_version_key" UNIQUE("provider_account_id","credential_version"),
	CONSTRAINT "provider_credentials_credential_version_check" CHECK (credential_version > 0),
	CONSTRAINT "provider_credentials_status_check" CHECK (status = ANY (ARRAY['active'::text, 'revoked'::text]))
);

CREATE TABLE "provider_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"sending_domain_id" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"external_identity_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"dns_records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_identities_id_provider_account_id_key" UNIQUE("id","provider_account_id"),
	CONSTRAINT "provider_identities_id_sending_domain_id_key" UNIQUE("id","sending_domain_id"),
	CONSTRAINT "provider_identities_sending_domain_id_provider_account_id_key" UNIQUE("sending_domain_id","provider_account_id"),
	CONSTRAINT "provider_identities_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'verified'::text, 'failed'::text, 'disabled'::text]))
);

CREATE TABLE "provider_webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_account_id" text NOT NULL,
	"opaque_token" text NOT NULL,
	"security_config_ciphertext" text,
	"security_encrypted_dek" text,
	"key_version" text,
	"security_version" integer DEFAULT 0 NOT NULL,
	"security_configured" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expected_topic_arn" text,
	"ip_allowlist" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_webhook_endpoints_provider_account_id_key" UNIQUE("provider_account_id"),
	CONSTRAINT "provider_webhook_endpoints_opaque_token_key" UNIQUE("opaque_token"),
	CONSTRAINT "provider_webhook_endpoints_status_check" CHECK (status = ANY (ARRAY['active'::text, 'disabled'::text]))
);

CREATE TABLE "sending_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sending_domains_domain_key" UNIQUE("domain"),
	CONSTRAINT "sending_domains_status_check" CHECK (status = ANY (ARRAY['active'::text, 'disabled'::text]))
);

CREATE TABLE "service_domain_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"sending_domain_id" text NOT NULL,
	"receive_enabled" boolean DEFAULT false NOT NULL,
	"outbound_provider_identity_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_domain_bindings_service_domain_key" UNIQUE("service_id","sending_domain_id")
);

CREATE TABLE "deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"recipient_email" text NOT NULL,
	"recipient_name" text,
	"recipient_role" text NOT NULL,
	"last_error" jsonb,
	"lifecycle_status" text DEFAULT 'queued' NOT NULL,
	"engagement_status" text DEFAULT 'unopened' NOT NULL,
	"compliance_status" text DEFAULT 'clean' NOT NULL,
	"current_attempt_id" text,
	"current_submission_id" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_message_id_recipient_email_key" UNIQUE("message_id","recipient_email"),
	CONSTRAINT "deliveries_recipient_role_check" CHECK (recipient_role = ANY (ARRAY['to'::text, 'cc'::text, 'bcc'::text])),
	CONSTRAINT "deliveries_lifecycle_status_check" CHECK (lifecycle_status = ANY (ARRAY['queued'::text, 'submitting'::text, 'accepted'::text, 'deferred'::text, 'delivered'::text, 'bounced'::text, 'failed'::text, 'unknown'::text, 'canceled'::text])),
	CONSTRAINT "deliveries_engagement_status_check" CHECK (engagement_status = ANY (ARRAY['unopened'::text, 'opened'::text, 'clicked'::text])),
	CONSTRAINT "deliveries_compliance_status_check" CHECK (compliance_status = ANY (ARRAY['clean'::text, 'complained'::text, 'unsubscribed'::text, 'suppressed'::text]))
);

CREATE TABLE "delivery_events" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"raw_provider_event_id" text,
	"event_type" text NOT NULL,
	"source_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"canonical_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_events_source_key_key" UNIQUE("source_key")
);

CREATE TABLE "message_retries" (
	"message_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_retries_pkey" PRIMARY KEY("message_id","idempotency_key")
);

CREATE TABLE "messages" (
	"content_purged_at" timestamp with time zone,
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"sending_domain_id" text NOT NULL,
	"request_id" text,
	"to_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"in_reply_to" text,
	"references_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"attachment_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sender_snapshot" jsonb NOT NULL,
	"content_policy" text DEFAULT 'normal' NOT NULL,
	"send_before" timestamp with time zone,
	"sensitive_content" jsonb,
	"sensitive_content_purged_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload_hash_key_version" text,
	"reference_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recipient_count" integer NOT NULL,
	"subject" text NOT NULL,
	"html_body" text,
	"text_body" text,
	"message_category" text NOT NULL,
	"reply_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_service_id_idempotency_key_key" UNIQUE("service_id","idempotency_key"),
	CONSTRAINT "messages_content_policy_check" CHECK (content_policy = ANY (ARRAY['normal'::text, 'sensitive'::text])),
	CONSTRAINT "messages_recipient_count_check" CHECK (recipient_count > 0),
	CONSTRAINT "messages_check" CHECK ((content_policy = 'sensitive'::text) OR (html_body IS NOT NULL) OR (text_body IS NOT NULL)),
	CONSTRAINT "messages_check1" CHECK ((content_policy <> 'sensitive'::text) OR (content_purged_at IS NOT NULL) OR ((send_before IS NOT NULL) AND (html_body IS NULL) AND (text_body IS NULL) AND (subject = '[Sensitive content]'::text) AND (metadata = '{}'::jsonb) AND (headers = '{}'::jsonb) AND (provider_tags = '{}'::jsonb))),
	CONSTRAINT "messages_check2" CHECK ((content_policy = 'sensitive'::text) OR (sensitive_content IS NULL))
);

CREATE TABLE "outbound_changes" (
	"service_id" text NOT NULL,
	"position" bigint NOT NULL,
	"id" text NOT NULL,
	"message_id" text NOT NULL,
	"type" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "outbound_changes_service_id_position_pk" PRIMARY KEY("service_id","position"),
	CONSTRAINT "outbound_changes_id_unique" UNIQUE("id")
);

CREATE TABLE "outbound_streams" (
	"service_id" text PRIMARY KEY NOT NULL,
	"generation" uuid DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint DEFAULT 0 NOT NULL,
	"floor" bigint DEFAULT 0 NOT NULL
);

CREATE TABLE "raw_provider_events" (
	"content_purged_at" timestamp with time zone,
	"id" text PRIMARY KEY NOT NULL,
	"provider_account_id" text NOT NULL,
	"webhook_endpoint_id" text NOT NULL,
	"provider_event_id" text,
	"native_type" text NOT NULL,
	"signature_valid" boolean NOT NULL,
	"replay_valid" boolean NOT NULL,
	"payload_expires_at" timestamp with time zone,
	"raw_payload_purged_at" timestamp with time zone,
	"normalized_events" jsonb,
	"raw_body" "bytea",
	"raw_object_key" text,
	"headers" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"terminated_at" timestamp with time zone,
	"processing_error" text,
	"verification" jsonb,
	"security_version" integer DEFAULT 0 NOT NULL,
	"processing_attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raw_provider_events_provider_account_id_provider_event_id_key" UNIQUE("provider_account_id","provider_event_id"),
	CONSTRAINT "raw_provider_events_processing_attempt_count_check" CHECK (processing_attempt_count >= 0)
);

CREATE TABLE "submission_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"provider_account_id" text NOT NULL,
	"provider_identity_id" text NOT NULL,
	"routing_snapshot" jsonb NOT NULL,
	"request_fingerprint" text NOT NULL,
	"provider_idempotency_key" text,
	"external_message_id" text,
	"rfc_message_id" text,
	"status" text NOT NULL,
	"outcome_determinate" boolean DEFAULT false NOT NULL,
	"error_category" text,
	"error_code" text,
	"error_message" text,
	"diagnostic" jsonb,
	"provider_response_ref" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"submission_deadline_at" timestamp with time zone DEFAULT (now() + '00:02:00'::interval) NOT NULL,
	"retry_authorized_at" timestamp with time zone,
	"retry_authorized_by" text,
	"reconciliation_count" integer DEFAULT 0 NOT NULL,
	"reconcile_after" timestamp with time zone,
	CONSTRAINT "submission_attempts_submission_id_attempt_number_key" UNIQUE("submission_id","attempt_number"),
	CONSTRAINT "submission_attempts_provider_account_id_external_message_id_key" UNIQUE("provider_account_id","external_message_id"),
	CONSTRAINT "submission_attempts_attempt_number_check" CHECK (attempt_number > 0),
	CONSTRAINT "submission_attempts_status_check" CHECK (status = ANY (ARRAY['submitting'::text, 'accepted'::text, 'failed'::text, 'unknown'::text, 'reconciling'::text, 'reconciled'::text])),
	CONSTRAINT "submission_attempts_reconciliation_count_check" CHECK (reconciliation_count >= 0)
);

CREATE TABLE "submission_deliveries" (
	"submission_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	CONSTRAINT "submission_deliveries_pkey" PRIMARY KEY("submission_id","delivery_id")
);

CREATE TABLE "submission_events" (
	"id" text PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"raw_provider_event_id" text,
	"attempt_id" text,
	"event_type" text NOT NULL,
	"source_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"canonical_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_events_source_key_key" UNIQUE("source_key")
);

CREATE TABLE "submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"current_attempt_id" text,
	"defer_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submissions_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'submitting'::text, 'accepted'::text, 'deferred'::text, 'unknown'::text, 'failed'::text, 'canceled'::text])),
	CONSTRAINT "submissions_defer_count_check" CHECK (defer_count >= 0)
);

CREATE TABLE "inbound_changes" (
	"service_id" text NOT NULL,
	"position" bigint NOT NULL,
	"id" text DEFAULT ('ich_'::text || (gen_random_uuid())::text) NOT NULL,
	"inbound_message_id" text NOT NULL,
	"type" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "inbound_changes_pkey" PRIMARY KEY("service_id","position"),
	CONSTRAINT "inbound_changes_id_key" UNIQUE("id"),
	CONSTRAINT "inbound_changes_type_check" CHECK (type = ANY (ARRAY['inbound.available'::text, 'inbound.content_purged'::text]))
);

CREATE TABLE "inbound_messages" (
	"content_purged_at" timestamp with time zone,
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text,
	"provider_account_id" text NOT NULL,
	"raw_provider_event_id" text,
	"external_message_id" text,
	"message_id" text,
	"delivery_scope" text DEFAULT 'quarantine' NOT NULL,
	"envelope_recipients" text[] DEFAULT '{}'::text[] NOT NULL,
	"reply_to" text[] DEFAULT '{}'::text[] NOT NULL,
	"in_reply_to" text,
	"references_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"from_email" text NOT NULL,
	"to_emails" text[] NOT NULL,
	"cc_emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"bcc_emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text NOT NULL,
	"sanitized_html" text,
	"text_body" text,
	"raw_mime_object_key" text,
	"status" text DEFAULT 'scanning' NOT NULL,
	"rejection_reason" text,
	"processing_token" text,
	"processing_deadline_at" timestamp with time zone,
	"author_date" timestamp with time zone,
	"ingress_received_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_messages_provider_account_id_external_message_id_de_key" UNIQUE("provider_account_id","external_message_id","delivery_scope"),
	CONSTRAINT "inbound_messages_status_check" CHECK (status = ANY (ARRAY['scanning'::text, 'ready'::text, 'rejected'::text]))
);

CREATE TABLE "inbound_receipts" (
	"provider_account_id" text NOT NULL,
	"external_message_id" text NOT NULL,
	"routes" jsonb NOT NULL,
	"terminated_at" timestamp with time zone,
	"ingress_received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inbound_receipts_pkey" PRIMARY KEY("provider_account_id","external_message_id")
);

CREATE TABLE "inbound_streams" (
	"service_id" text PRIMARY KEY NOT NULL,
	"generation" uuid DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint DEFAULT 0 NOT NULL,
	"floor" bigint DEFAULT 0 NOT NULL
);

CREATE TABLE "attachment_safety" (
	"resource_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"service_id" text,
	"scope" text NOT NULL,
	"expected_sha256" text NOT NULL,
	"scanned_sha256" text,
	"policy_version" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_until" timestamp with time zone,
	"outbox_id" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_safety_kind_check" CHECK (kind = ANY (ARRAY['outbound'::text, 'inbound'::text])),
	CONSTRAINT "attachment_safety_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'scanning'::text, 'clean'::text, 'malicious'::text, 'unavailable'::text, 'blocked'::text, 'purged'::text]))
);

CREATE TABLE "attachment_scan_scopes" (
	"scope" text PRIMARY KEY NOT NULL,
	"last_dispatched_at" timestamp with time zone DEFAULT '-infinity' NOT NULL
);

CREATE TABLE "inbound_attachments" (
	"content_purged_at" timestamp with time zone,
	"id" text PRIMARY KEY NOT NULL,
	"inbound_message_id" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"object_key" text NOT NULL,
	"content_id" text,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "outbound_files" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"sending_domain_id" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"content_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_files_object_key_key" UNIQUE("object_key"),
	CONSTRAINT "outbound_files_size_bytes_check" CHECK (size_bytes > 0)
);

CREATE TABLE "pending_object_deletions" (
	"object_key" text PRIMARY KEY NOT NULL,
	"available_at" timestamp with time zone DEFAULT (now() + '00:10:00'::interval) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pending_object_deletions_attempt_count_check" CHECK (attempt_count >= 0)
);

CREATE TABLE "callback_deliveries" (
	"payload_purged_at" timestamp with time zone,
	"id" text PRIMARY KEY NOT NULL,
	"endpoint_id" text NOT NULL,
	"delivery_event_id" text,
	"submission_event_id" text,
	"inbound_message_id" text,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"response_code" integer,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"terminated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "callback_deliveries_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'delivering'::text, 'delivered'::text, 'retrying'::text, 'dead_letter'::text, 'terminated'::text]))
);

CREATE TABLE "callback_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"secret_ciphertext" text NOT NULL,
	"encrypted_dek" text NOT NULL,
	"key_version" text NOT NULL,
	"subscribed_events" text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "callback_endpoints_status_check" CHECK (status = ANY (ARRAY['active'::text, 'disabled'::text])),
	CONSTRAINT "callback_url_nonempty" CHECK ((url IS NULL) OR (url <> ''::text)),
	CONSTRAINT "active_callback_requires_url" CHECK ((status <> 'active'::text) OR (url IS NOT NULL))
);

CREATE TABLE "suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_type" text NOT NULL,
	"service_id" text,
	"list_id" text,
	"email_normalized" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"bounce_count" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppressions_scope_type_check" CHECK (scope_type = ANY (ARRAY['global'::text, 'service'::text, 'list'::text])),
	CONSTRAINT "suppressions_check" CHECK (((scope_type = 'global'::text) AND (service_id IS NULL) AND (list_id IS NULL)) OR ((scope_type = 'service'::text) AND (service_id IS NOT NULL) AND (list_id IS NULL)) OR ((scope_type = 'list'::text) AND (service_id IS NOT NULL) AND (list_id IS NOT NULL))),
	CONSTRAINT "suppressions_email_normalized_check" CHECK (email_normalized = lower(email_normalized))
);

CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "outbox_events" (
	"id" text PRIMARY KEY NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'published'::text, 'failed'::text]))
);

CREATE TABLE "rate_limit_counters" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY("scope","key","window_start"),
	CONSTRAINT "rate_limit_counters_count_check" CHECK (count >= 0)
);

CREATE TABLE "request_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"service_id" text,
	"message_id" text,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status_code" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"actor" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_logs_request_id_key" UNIQUE("request_id")
);

CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "service_credentials" ADD CONSTRAINT "service_credentials_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "provider_identities" ADD CONSTRAINT "provider_identities_sending_domain_id_fkey" FOREIGN KEY ("sending_domain_id") REFERENCES "public"."sending_domains"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "provider_identities" ADD CONSTRAINT "provider_identities_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "provider_webhook_endpoints" ADD CONSTRAINT "provider_webhook_endpoints_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "service_domain_bindings" ADD CONSTRAINT "service_domain_bindings_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "service_domain_bindings" ADD CONSTRAINT "service_domain_bindings_sending_domain_id_fkey" FOREIGN KEY ("sending_domain_id") REFERENCES "public"."sending_domains"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "service_domain_bindings" ADD CONSTRAINT "service_domain_bindings_outbound_identity_domain_fkey" FOREIGN KEY ("outbound_provider_identity_id","sending_domain_id") REFERENCES "public"."provider_identities"("id","sending_domain_id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_current_submission_fk" FOREIGN KEY ("current_submission_id") REFERENCES "public"."submissions"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_current_attempt_fk" FOREIGN KEY ("current_attempt_id") REFERENCES "public"."submission_attempts"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_raw_provider_event_id_fkey" FOREIGN KEY ("raw_provider_event_id") REFERENCES "public"."raw_provider_events"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "message_retries" ADD CONSTRAINT "message_retries_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "messages" ADD CONSTRAINT "messages_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "messages" ADD CONSTRAINT "messages_sending_domain_id_fkey" FOREIGN KEY ("sending_domain_id") REFERENCES "public"."sending_domains"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "outbound_changes" ADD CONSTRAINT "outbound_changes_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "outbound_changes" ADD CONSTRAINT "outbound_changes_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "outbound_streams" ADD CONSTRAINT "outbound_streams_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "raw_provider_events" ADD CONSTRAINT "raw_provider_events_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "raw_provider_events" ADD CONSTRAINT "raw_provider_events_webhook_endpoint_id_fkey" FOREIGN KEY ("webhook_endpoint_id") REFERENCES "public"."provider_webhook_endpoints"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "submission_attempts" ADD CONSTRAINT "submission_attempts_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "submission_attempts" ADD CONSTRAINT "submission_attempts_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "submission_attempts" ADD CONSTRAINT "submission_attempts_provider_identity_id_fkey" FOREIGN KEY ("provider_identity_id") REFERENCES "public"."provider_identities"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "submission_deliveries" ADD CONSTRAINT "submission_deliveries_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "submission_deliveries" ADD CONSTRAINT "submission_deliveries_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "submission_events" ADD CONSTRAINT "submission_events_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "submission_events" ADD CONSTRAINT "submission_events_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "public"."submission_attempts"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "submission_events" ADD CONSTRAINT "submission_events_raw_event_fk" FOREIGN KEY ("raw_provider_event_id") REFERENCES "public"."raw_provider_events"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_current_attempt_fk" FOREIGN KEY ("current_attempt_id") REFERENCES "public"."submission_attempts"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "inbound_changes" ADD CONSTRAINT "inbound_changes_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inbound_changes" ADD CONSTRAINT "inbound_changes_inbound_message_id_fkey" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."inbound_messages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_raw_provider_event_id_fkey" FOREIGN KEY ("raw_provider_event_id") REFERENCES "public"."raw_provider_events"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "inbound_receipts" ADD CONSTRAINT "inbound_receipts_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "inbound_streams" ADD CONSTRAINT "inbound_streams_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "attachment_safety" ADD CONSTRAINT "attachment_safety_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "attachment_safety" ADD CONSTRAINT "attachment_safety_scope_fkey" FOREIGN KEY ("scope") REFERENCES "public"."attachment_scan_scopes"("scope") ON DELETE no action ON UPDATE no action;
ALTER TABLE "inbound_attachments" ADD CONSTRAINT "inbound_attachments_inbound_message_id_fkey" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."inbound_messages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "outbound_files" ADD CONSTRAINT "outbound_files_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "outbound_files" ADD CONSTRAINT "outbound_files_sending_domain_id_fkey" FOREIGN KEY ("sending_domain_id") REFERENCES "public"."sending_domains"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "callback_deliveries" ADD CONSTRAINT "callback_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "public"."callback_endpoints"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "callback_deliveries" ADD CONSTRAINT "callback_deliveries_delivery_event_id_fkey" FOREIGN KEY ("delivery_event_id") REFERENCES "public"."delivery_events"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "callback_deliveries" ADD CONSTRAINT "callback_deliveries_submission_event_id_fkey" FOREIGN KEY ("submission_event_id") REFERENCES "public"."submission_events"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "callback_deliveries" ADD CONSTRAINT "callback_deliveries_inbound_message_id_fkey" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."inbound_messages"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "callback_endpoints" ADD CONSTRAINT "callback_endpoints_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
CREATE UNIQUE INDEX "services_name_key" ON "services" USING btree (lower("name"));
CREATE UNIQUE INDEX "provider_credentials_one_active" ON "provider_credentials" USING btree ("provider_account_id") WHERE (status = 'active'::text);
CREATE INDEX "service_domain_bindings_inbound_fanout" ON "service_domain_bindings" USING btree ("sending_domain_id") WHERE "service_domain_bindings"."receive_enabled";
CREATE INDEX "deliveries_lifecycle_idx" ON "deliveries" USING btree ("lifecycle_status","queued_at" DESC NULLS FIRST);
CREATE INDEX "deliveries_message_status" ON "deliveries" USING btree ("message_id","lifecycle_status");
CREATE INDEX "delivery_events_delivery_occurred_cursor" ON "delivery_events" USING btree ("delivery_id","occurred_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
CREATE INDEX "delivery_events_timeline_idx" ON "delivery_events" USING btree ("delivery_id","occurred_at" DESC NULLS FIRST);
CREATE INDEX "messages_sensitive_expiry_idx" ON "messages" USING btree ("send_before") WHERE (sensitive_content IS NOT NULL);
CREATE INDEX "messages_service_accepted_cursor" ON "messages" USING btree ("service_id","accepted_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
CREATE INDEX "raw_events_retry_due" ON "raw_provider_events" USING btree ("next_attempt_at") WHERE (processed_at IS NULL);
CREATE INDEX "raw_provider_events_pending_idx" ON "raw_provider_events" USING btree ("processed_at","received_at");
CREATE INDEX "attempts_external_idx" ON "submission_attempts" USING btree ("provider_account_id","external_message_id");
CREATE INDEX "attempts_reconcile_due" ON "submission_attempts" USING btree ("reconcile_after") WHERE (status = ANY (ARRAY['unknown'::text, 'reconciling'::text]));
CREATE INDEX "provider_attempt_usage" ON "submission_attempts" USING btree ("provider_account_id","started_at");
CREATE INDEX "submission_deliveries_delivery" ON "submission_deliveries" USING btree ("delivery_id");
CREATE INDEX "submission_events_evidence" ON "submission_events" USING btree ("submission_id","event_type","occurred_at" DESC NULLS FIRST);
CREATE INDEX "submission_events_raw_event_idx" ON "submission_events" USING btree ("raw_provider_event_id") WHERE (raw_provider_event_id IS NOT NULL);
CREATE INDEX "submission_events_timeline" ON "submission_events" USING btree ("submission_id","occurred_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
CREATE INDEX "submissions_message" ON "submissions" USING btree ("message_id");
CREATE INDEX "submissions_recovery" ON "submissions" USING btree ("status","updated_at") WHERE (status = ANY (ARRAY['queued'::text, 'deferred'::text, 'submitting'::text, 'unknown'::text]));
CREATE INDEX "inbound_evidence" ON "inbound_messages" USING btree ("service_id","provider_account_id","created_at" DESC NULLS FIRST) WHERE (status = 'ready'::text);
CREATE INDEX "inbound_messages_received_idx" ON "inbound_messages" USING btree ("received_at" DESC NULLS FIRST);
CREATE INDEX "inbound_messages_service_received_cursor" ON "inbound_messages" USING btree ("service_id","received_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
CREATE INDEX "inbound_messages_service_stored_cursor" ON "inbound_messages" USING btree ("service_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
CREATE INDEX "inbound_scan_due" ON "inbound_messages" USING btree ("processing_deadline_at") WHERE (status = 'scanning'::text);
CREATE INDEX "attachment_safety_due" ON "attachment_safety" USING btree ("scope","next_attempt_at","resource_id") WHERE (status <> ALL (ARRAY['malicious'::text, 'blocked'::text, 'purged'::text]));
CREATE INDEX "pending_object_deletions_due" ON "pending_object_deletions" USING btree ("available_at");
CREATE INDEX "callback_deliveries_pending_idx" ON "callback_deliveries" USING btree ("status","next_attempt_at");
CREATE UNIQUE INDEX "callback_delivery_event_once" ON "callback_deliveries" USING btree ("endpoint_id","delivery_event_id") WHERE (delivery_event_id IS NOT NULL);
CREATE UNIQUE INDEX "callback_inbound_event_once" ON "callback_deliveries" USING btree ("endpoint_id","inbound_message_id","event_type") WHERE (inbound_message_id IS NOT NULL);
CREATE UNIQUE INDEX "callback_submission_event_once" ON "callback_deliveries" USING btree ("endpoint_id","submission_event_id") WHERE (submission_event_id IS NOT NULL);
CREATE UNIQUE INDEX "callback_one_per_service" ON "callback_endpoints" USING btree ("service_id");
CREATE UNIQUE INDEX "suppressions_active_scope" ON "suppressions" USING btree (scope_type,COALESCE(service_id, '*'::text),COALESCE(list_id, '*'::text),email_normalized) WHERE (active = true);
CREATE INDEX "outbox_pending_idx" ON "outbox_events" USING btree ("status","available_at","created_at");
CREATE INDEX "rate_limit_expiry" ON "rate_limit_counters" USING btree ("expires_at");
CREATE INDEX "request_logs_created_idx" ON "request_logs" USING btree ("created_at" DESC NULLS FIRST);
CREATE INDEX "request_logs_service" ON "request_logs" USING btree ("service_id","created_at" DESC NULLS FIRST);
CREATE INDEX "worker_heartbeat_recency" ON "worker_heartbeats" USING btree ("last_seen_at");

-- Database-enforced inbound change ordering and attachment purge fencing.

CREATE FUNCTION record_inbound_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE change_type text; next_position bigint;
BEGIN
  IF NEW.service_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.content_purged_at IS NOT NULL AND OLD.content_purged_at IS NULL THEN
    change_type := 'inbound.content_purged';
  ELSIF NEW.status='ready' AND OLD.status<>'ready' AND NEW.content_purged_at IS NULL THEN
    change_type := 'inbound.available';
  ELSE RETURN NEW;
  END IF;
  INSERT INTO inbound_streams(service_id) VALUES(NEW.service_id) ON CONFLICT DO NOTHING;
  UPDATE inbound_streams SET position=position+1 WHERE service_id=NEW.service_id RETURNING position INTO next_position;
  INSERT INTO inbound_changes(service_id,position,inbound_message_id,type)
    VALUES(NEW.service_id,next_position,NEW.id,change_type);
  RETURN NEW;
END $$;

CREATE TRIGGER inbound_change AFTER UPDATE ON inbound_messages FOR EACH ROW EXECUTE FUNCTION record_inbound_change();

CREATE FUNCTION fence_purged_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_purged_at IS NOT NULL AND OLD.content_purged_at IS NULL THEN
    UPDATE attachment_safety SET status='purged',reason='FILE_CONTENT_PURGED',lease_token=NULL,lease_expires_at=NULL,
      queued_until=NULL,updated_at=now() WHERE resource_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER outbound_attachment_purge AFTER UPDATE ON outbound_files FOR EACH ROW EXECUTE FUNCTION fence_purged_attachment();

CREATE TRIGGER inbound_attachment_purge AFTER UPDATE ON inbound_attachments FOR EACH ROW EXECUTE FUNCTION fence_purged_attachment();

CREATE FUNCTION record_outbound_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_service text; owner_message text; next_position bigint;
BEGIN
  IF TG_TABLE_NAME='delivery_events' THEN
    SELECT m.service_id,m.id INTO owner_service,owner_message FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE d.id=NEW.delivery_id;
  ELSE
    SELECT m.service_id,m.id INTO owner_service,owner_message FROM messages m JOIN submissions s ON s.message_id=m.id WHERE s.id=NEW.submission_id;
  END IF;
  INSERT INTO outbound_streams(service_id) VALUES(owner_service) ON CONFLICT DO NOTHING;
  UPDATE outbound_streams SET position=position+1 WHERE service_id=owner_service RETURNING position INTO next_position;
  INSERT INTO outbound_changes(service_id,position,id,message_id,type) VALUES(owner_service,next_position,NEW.id,owner_message,NEW.event_type);
  RETURN NEW;
END $$;

CREATE TRIGGER outbound_delivery_change AFTER INSERT ON delivery_events FOR EACH ROW EXECUTE FUNCTION record_outbound_change();
CREATE TRIGGER outbound_submission_change AFTER INSERT ON submission_events FOR EACH ROW EXECUTE FUNCTION record_outbound_change();

-- Business data dictionary maintained in schema/documentation.ts; do not add separate comment migrations.
COMMENT ON TABLE "attachment_safety" IS 'Shared inbound/outbound attachment scan state and leases; content digests and policy versions determine whether scan results can be reused';
COMMENT ON COLUMN "attachment_safety"."resource_id" IS 'Globally unique scanned attachment identifier referencing an outbound file or inbound attachment';
COMMENT ON COLUMN "attachment_safety"."kind" IS 'Attachment source: outbound (uploaded file) or inbound (received attachment)';
COMMENT ON COLUMN "attachment_safety"."service_id" IS 'Owning service; may be null for administrator quarantine attachments';
COMMENT ON COLUMN "attachment_safety"."scope" IS 'Fair scan scheduling scope: service identifier, or administrator when unassigned';
COMMENT ON COLUMN "attachment_safety"."expected_sha256" IS 'Expected SHA-256 content digest registered to detect object replacement';
COMMENT ON COLUMN "attachment_safety"."scanned_sha256" IS 'Actual scanned content SHA-256 digest; a clean result must match the expected digest';
COMMENT ON COLUMN "attachment_safety"."policy_version" IS 'Safety policy version producing the scan result; policy changes require rescanning stale results';
COMMENT ON COLUMN "attachment_safety"."status" IS 'Scan status: pending, scanning, clean (safe), malicious, unavailable (scanner unavailable), blocked or purged';
COMMENT ON COLUMN "attachment_safety"."reason" IS 'Scan or block reason code, including content purge, digest mismatch or malicious content';
COMMENT ON COLUMN "attachment_safety"."attempt_count" IS 'Non-negative scan attempt count';
COMMENT ON COLUMN "attachment_safety"."next_attempt_at" IS 'Earliest next scan retry time (timestamptz)';
COMMENT ON COLUMN "attachment_safety"."queued_until" IS 'Queued scan reservation deadline (timestamptz) preventing duplicate dispatch';
COMMENT ON COLUMN "attachment_safety"."outbox_id" IS 'Transactional outbox event associated with this scan dispatch';
COMMENT ON COLUMN "attachment_safety"."lease_token" IS 'Random scan execution lease token required when writing results';
COMMENT ON COLUMN "attachment_safety"."lease_expires_at" IS 'Scan execution lease expiry (timestamptz); another worker may reclaim work after expiry';
COMMENT ON COLUMN "attachment_safety"."checked_at" IS 'Latest scan result time (timestamptz)';
COMMENT ON COLUMN "attachment_safety"."updated_at" IS 'Last update time (timestamptz); explicitly maintained by business writes, defaults to now()';
COMMENT ON TABLE "attachment_scan_scopes" IS 'Per-service fair attachment scan scheduling cursors limiting monopolization and rotating due work';
COMMENT ON COLUMN "attachment_scan_scopes"."scope" IS 'Unique scan scope key: service identifier or administrator';
COMMENT ON COLUMN "attachment_scan_scopes"."last_dispatched_at" IS 'Last scope dispatch time (timestamptz, written with clock_timestamp()); initially -infinity to prioritize first dispatch';
COMMENT ON TABLE "audit_logs" IS 'Administrative audit facts recording actors, resources and redacted change details';
COMMENT ON COLUMN "audit_logs"."id" IS 'Database-generated bigint audit sequence number, not a business resource identifier';
COMMENT ON COLUMN "audit_logs"."actor" IS 'Actor performing the administrative operation';
COMMENT ON COLUMN "audit_logs"."action" IS 'Administrative operation name or code';
COMMENT ON COLUMN "audit_logs"."resource_type" IS 'Business type of the affected resource';
COMMENT ON COLUMN "audit_logs"."resource_id" IS 'Affected resource identifier; null when no specific resource applies';
COMMENT ON COLUMN "audit_logs"."details" IS 'Audit detail JSON containing redacted summaries; plaintext credentials and sensitive bodies are forbidden';
COMMENT ON COLUMN "audit_logs"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON TABLE "callback_deliveries" IS 'Reliable business callback delivery tasks with source events, retry schedules and termination state';
COMMENT ON COLUMN "callback_deliveries"."payload_purged_at" IS 'Callback payload purge time (timestamptz); retains task metadata and forbids delivery using purged payloads';
COMMENT ON COLUMN "callback_deliveries"."id" IS 'Unique callback delivery task identifier';
COMMENT ON COLUMN "callback_deliveries"."endpoint_id" IS 'Target callback endpoint identifier';
COMMENT ON COLUMN "callback_deliveries"."delivery_event_id" IS 'Related recipient delivery event; null for other sources or after event deletion';
COMMENT ON COLUMN "callback_deliveries"."submission_event_id" IS 'Related submission event; null for other sources or after event deletion';
COMMENT ON COLUMN "callback_deliveries"."inbound_message_id" IS 'Related inbound message; null for other sources or after message deletion';
COMMENT ON COLUMN "callback_deliveries"."event_type" IS 'Canonical business event type being reported';
COMMENT ON COLUMN "callback_deliveries"."payload" IS 'Business event JSON sent to the callback target; subject to retention and must not contain provider secrets';
COMMENT ON COLUMN "callback_deliveries"."status" IS 'Callback status: pending, delivering, delivered, retrying, dead_letter (retries exhausted) or terminated';
COMMENT ON COLUMN "callback_deliveries"."attempt_count" IS 'Number of HTTP delivery attempts executed';
COMMENT ON COLUMN "callback_deliveries"."response_code" IS 'Latest target HTTP response status code; null when no response was received';
COMMENT ON COLUMN "callback_deliveries"."last_error" IS 'Latest redacted callback delivery failure reason';
COMMENT ON COLUMN "callback_deliveries"."next_attempt_at" IS 'Earliest next retry time (timestamptz)';
COMMENT ON COLUMN "callback_deliveries"."delivered_at" IS 'Successful callback delivery time (timestamptz)';
COMMENT ON COLUMN "callback_deliveries"."terminated_at" IS 'Termination time stopping further deliveries (timestamptz)';
COMMENT ON COLUMN "callback_deliveries"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON COLUMN "callback_deliveries"."updated_at" IS 'Last update time (timestamptz); explicitly maintained by business writes, defaults to now()';
COMMENT ON TABLE "callback_endpoints" IS 'Service callback destinations and envelope-encrypted signing secrets; at most one endpoint per service';
COMMENT ON COLUMN "callback_endpoints"."id" IS 'Unique callback endpoint identifier';
COMMENT ON COLUMN "callback_endpoints"."service_id" IS 'Owning service identifier, unique per endpoint';
COMMENT ON COLUMN "callback_endpoints"."name" IS 'Callback endpoint display name';
COMMENT ON COLUMN "callback_endpoints"."url" IS 'Callback HTTP URL; required and nonempty when active, with SSRF safety checks applied during delivery';
COMMENT ON COLUMN "callback_endpoints"."secret_ciphertext" IS 'Encrypted callback signing secret; plaintext signing keys must not be stored here';
COMMENT ON COLUMN "callback_endpoints"."encrypted_dek" IS 'Encrypted DEK for the callback signing secret';
COMMENT ON COLUMN "callback_endpoints"."key_version" IS 'Master key version wrapping the callback DEK';
COMMENT ON COLUMN "callback_endpoints"."subscribed_events" IS 'Subscribed canonical business event type array; only matching events generate callbacks';
COMMENT ON COLUMN "callback_endpoints"."status" IS 'Endpoint status: active (enabled) or disabled';
COMMENT ON COLUMN "callback_endpoints"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON COLUMN "callback_endpoints"."updated_at" IS 'Last update time (timestamptz); explicitly maintained by business writes, defaults to now()';
COMMENT ON TABLE "deliveries" IS 'Per-recipient outbound delivery state, with independent lifecycle, engagement and compliance statuses';
COMMENT ON COLUMN "deliveries"."id" IS 'Unique recipient delivery identifier';
COMMENT ON COLUMN "deliveries"."message_id" IS 'Owning outbound message identifier';
COMMENT ON COLUMN "deliveries"."recipient_email" IS 'Recipient email address, unique within the message';
COMMENT ON COLUMN "deliveries"."recipient_name" IS 'Optional recipient display name';
COMMENT ON COLUMN "deliveries"."recipient_role" IS 'Recipient role: to (primary), cc (carbon copy) or bcc (blind copy)';
COMMENT ON COLUMN "deliveries"."last_error" IS 'Latest delivery error JSON containing code, category and description; may be null after success or when no error exists';
COMMENT ON COLUMN "deliveries"."lifecycle_status" IS 'Delivery lifecycle: queued, submitting, accepted, deferred, delivered, bounced, failed, unknown (indeterminate outcome) or canceled';
COMMENT ON COLUMN "deliveries"."engagement_status" IS 'Engagement status: unopened, opened or clicked';
COMMENT ON COLUMN "deliveries"."compliance_status" IS 'Compliance status: clean (unrestricted), complained, unsubscribed or suppressed';
COMMENT ON COLUMN "deliveries"."current_attempt_id" IS 'Current provider submission attempt; null when absent or deleted';
COMMENT ON COLUMN "deliveries"."current_submission_id" IS 'Current sending submission; null when absent or deleted';
COMMENT ON COLUMN "deliveries"."queued_at" IS 'Time this recipient delivery entered the system queue (timestamptz)';
COMMENT ON COLUMN "deliveries"."accepted_at" IS 'Provider event time confirming acceptance for this recipient (timestamptz)';
COMMENT ON COLUMN "deliveries"."delivered_at" IS 'Provider event time reporting final delivery (timestamptz)';
COMMENT ON COLUMN "deliveries"."updated_at" IS 'Last update time (timestamptz); explicitly maintained by business writes, defaults to now()';
COMMENT ON TABLE "delivery_events" IS 'Canonical per-recipient delivery facts; source_key prevents duplicate recording of repeated notifications';
COMMENT ON COLUMN "delivery_events"."id" IS 'Unique delivery event identifier';
COMMENT ON COLUMN "delivery_events"."delivery_id" IS 'Recipient delivery associated with this event';
COMMENT ON COLUMN "delivery_events"."raw_provider_event_id" IS 'Source raw provider event; null for internal events or after source deletion';
COMMENT ON COLUMN "delivery_events"."event_type" IS 'Canonical delivery event type driving lifecycle, engagement or compliance state';
COMMENT ON COLUMN "delivery_events"."source_key" IS 'Globally unique event source deduplication key';
COMMENT ON COLUMN "delivery_events"."occurred_at" IS 'Actual event time from the provider or internal action (timestamptz)';
COMMENT ON COLUMN "delivery_events"."canonical_payload" IS 'Canonical event JSON containing type, time, reason and associated metadata';
COMMENT ON COLUMN "delivery_events"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON TABLE "inbound_attachments" IS 'Inbound attachment metadata inheriting the owning message service isolation and retention policy';
COMMENT ON COLUMN "inbound_attachments"."content_purged_at" IS 'Irreversible content purge time (timestamptz); a non-null value prevents content reads while retaining business metadata';
COMMENT ON COLUMN "inbound_attachments"."id" IS 'Unique inbound attachment identifier';
COMMENT ON COLUMN "inbound_attachments"."inbound_message_id" IS 'Owning inbound message identifier; metadata is deleted when the message is deleted';
COMMENT ON COLUMN "inbound_attachments"."file_name" IS 'Provider-supplied attachment filename; requires safe download header encoding';
COMMENT ON COLUMN "inbound_attachments"."content_type" IS 'Provider-declared attachment MIME type; does not establish scan safety';
COMMENT ON COLUMN "inbound_attachments"."size_bytes" IS 'Attachment content size in bytes';
COMMENT ON COLUMN "inbound_attachments"."object_key" IS 'Private object storage key for the attachment';
COMMENT ON COLUMN "inbound_attachments"."content_id" IS 'MIME Content-ID for inline attachments; may be null for regular attachments';
COMMENT ON COLUMN "inbound_attachments"."sha256" IS 'Write-time hexadecimal SHA-256 content digest used to verify scanned content consistency';
COMMENT ON COLUMN "inbound_attachments"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON TABLE "inbound_changes" IS 'Per-service ordered inbound change facts; triggers write atomically with message availability or content purge';
COMMENT ON COLUMN "inbound_changes"."service_id" IS 'Owning service identifier; composite primary key with position';
COMMENT ON COLUMN "inbound_changes"."position" IS 'Monotonically increasing per-service bigint position allocated under an inbound_streams row lock; not a timestamp';
COMMENT ON COLUMN "inbound_changes"."id" IS 'Globally unique inbound change identifier, defaulting to ich_ plus a random UUID';
COMMENT ON COLUMN "inbound_changes"."inbound_message_id" IS 'Inbound message affected by the change';
COMMENT ON COLUMN "inbound_changes"."type" IS 'Change type: inbound.available (message becomes available) or inbound.content_purged (content removed)';
COMMENT ON COLUMN "inbound_changes"."recorded_at" IS 'Change recording time (timestamptz, defaults to wall-clock clock_timestamp()); stream ordering uses position';
COMMENT ON TABLE "inbound_messages" IS 'Inbound messages and service-isolated copies; quarantined mail has no service owner and business reads require completed scanning';
COMMENT ON COLUMN "inbound_messages"."content_purged_at" IS 'Irreversible content purge time (timestamptz); a non-null value prevents content reads while retaining business metadata';
COMMENT ON COLUMN "inbound_messages"."id" IS 'Unique inbound message identifier';
COMMENT ON COLUMN "inbound_messages"."service_id" IS 'Owning service; null for quarantined mail or after service deletion';
COMMENT ON COLUMN "inbound_messages"."provider_account_id" IS 'Provider account receiving the message';
COMMENT ON COLUMN "inbound_messages"."raw_provider_event_id" IS 'Source raw webhook event; null after source event deletion';
COMMENT ON COLUMN "inbound_messages"."external_message_id" IS 'Provider inbound message identifier, deduplicated with account and delivery scope';
COMMENT ON COLUMN "inbound_messages"."message_id" IS 'RFC Message-ID from email headers; not an outbound messages primary key';
COMMENT ON COLUMN "inbound_messages"."delivery_scope" IS 'Ownership scope key for isolated copies; quarantine for unassigned mail, service-specific for routed copies; used for provider message deduplication';
COMMENT ON COLUMN "inbound_messages"."envelope_recipients" IS 'Provider-authenticated SMTP envelope recipient array used for routing and authorization; untrusted email headers must not replace it';
COMMENT ON COLUMN "inbound_messages"."reply_to" IS 'Reply-To email header address array';
COMMENT ON COLUMN "inbound_messages"."in_reply_to" IS 'RFC Message-ID from the In-Reply-To header';
COMMENT ON COLUMN "inbound_messages"."references_ids" IS 'Ordered RFC Message-ID array from the References header';
COMMENT ON COLUMN "inbound_messages"."from_email" IS 'Sender email header content; does not establish authenticated identity';
COMMENT ON COLUMN "inbound_messages"."to_emails" IS 'Primary recipient email header array; not trusted for envelope routing';
COMMENT ON COLUMN "inbound_messages"."cc_emails" IS 'Carbon-copy email header address array';
COMMENT ON COLUMN "inbound_messages"."bcc_emails" IS 'Provider-supplied blind-copy address array, possibly empty and isolated by service permissions';
COMMENT ON COLUMN "inbound_messages"."subject" IS 'Inbound email subject, subject to content retention policy';
COMMENT ON COLUMN "inbound_messages"."sanitized_html" IS 'Sanitized HTML body; unsanitized provider content must not be served directly';
COMMENT ON COLUMN "inbound_messages"."text_body" IS 'Inbound email plain-text body';
COMMENT ON COLUMN "inbound_messages"."raw_mime_object_key" IS 'Optional private object storage key for the original MIME message';
COMMENT ON COLUMN "inbound_messages"."status" IS 'Processing status: scanning (processing or awaiting scan), ready (content available) or rejected';
COMMENT ON COLUMN "inbound_messages"."rejection_reason" IS 'Reason code or description for rejection or unavailable content';
COMMENT ON COLUMN "inbound_messages"."processing_token" IS 'Random processing lease token preventing stale workers from overwriting newer results';
COMMENT ON COLUMN "inbound_messages"."processing_deadline_at" IS 'Current inbound processing lease deadline (timestamptz); recovery may reclaim expired work';
COMMENT ON COLUMN "inbound_messages"."author_date" IS 'Author-declared Date header value (timestamptz); untrusted and not used for system receipt ordering';
COMMENT ON COLUMN "inbound_messages"."ingress_received_at" IS 'Initial webhook ingress receipt time (timestamptz); preserved across retries';
COMMENT ON COLUMN "inbound_messages"."ready_at" IS 'Time the message first completed processing and became available (timestamptz)';
COMMENT ON COLUMN "inbound_messages"."received_at" IS 'Inbound record receipt clock (timestamptz, defaults to wall-clock clock_timestamp()), distinct from transaction start time';
COMMENT ON COLUMN "inbound_messages"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON TABLE "inbound_receipts" IS 'Idempotent receipts freezing initial provider inbound routing results; retries reuse the first receipt time and ownership snapshot';
COMMENT ON COLUMN "inbound_receipts"."provider_account_id" IS 'Receiving provider account; composite primary key with external_message_id';
COMMENT ON COLUMN "inbound_receipts"."external_message_id" IS 'Provider inbound message identifier, unique within the account';
COMMENT ON COLUMN "inbound_receipts"."routes" IS 'Initial route JSON array containing route id, service_id and matched recipients; retries must not reassign ownership';
COMMENT ON COLUMN "inbound_receipts"."terminated_at" IS 'Inbound receipt processing termination time (timestamptz); non-null forbids further processing';
COMMENT ON COLUMN "inbound_receipts"."ingress_received_at" IS 'Initial webhook receipt time (timestamptz), reused unchanged on retries';
COMMENT ON TABLE "inbound_streams" IS 'Per-service inbound change stream cursors; row locks keep positions monotonically ordered within each service';
COMMENT ON COLUMN "inbound_streams"."service_id" IS 'Owning service identifier, with one stream per service';
COMMENT ON COLUMN "inbound_streams"."generation" IS 'Stream generation UUID identifying rebuilds and invalidating earlier cursors';
COMMENT ON COLUMN "inbound_streams"."position" IS 'Latest allocated per-service change position; bigint starting at zero, not a time value';
COMMENT ON COLUMN "inbound_streams"."floor" IS 'Purged change position lower bound; bigint, with older cursors requiring resynchronization';
COMMENT ON TABLE "message_retries" IS 'Idempotency records for message retry operations; repeated message/key pairs reuse the original result';
COMMENT ON COLUMN "message_retries"."message_id" IS 'Outbound message being retried';
COMMENT ON COLUMN "message_retries"."idempotency_key" IS 'Caller retry operation key, unique within the message';
COMMENT ON COLUMN "message_retries"."payload_hash" IS 'Retry request digest detecting different requests reusing the same idempotency key';
COMMENT ON COLUMN "message_retries"."result" IS 'Initial retry operation result JSON returned unchanged for repeated requests';
COMMENT ON COLUMN "message_retries"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON TABLE "messages" IS 'Outbound message requests and immutable sending snapshots; deduplicated by service and idempotency key, with sensitive content envelope-encrypted';
COMMENT ON COLUMN "messages"."content_purged_at" IS 'Irreversible content purge time (timestamptz); a non-null value prevents content reads while retaining business metadata';
COMMENT ON COLUMN "messages"."id" IS 'Unique outbound message identifier';
COMMENT ON COLUMN "messages"."service_id" IS 'Service that submitted this message';
COMMENT ON COLUMN "messages"."sending_domain_id" IS 'Sending domain used by this message';
COMMENT ON COLUMN "messages"."request_id" IS 'Optional trace identifier of the API request accepting this message';
COMMENT ON COLUMN "messages"."to_recipients" IS 'JSON array of primary recipients with email and optional name; sensitive messages retain only addresses in plaintext';
COMMENT ON COLUMN "messages"."cc_recipients" IS 'JSON array of carbon-copy recipients with email and optional name; sensitive messages retain only addresses in plaintext';
COMMENT ON COLUMN "messages"."bcc_recipients" IS 'JSON array of blind-copy recipients, restricted to authorized internal flows; sensitive messages retain only addresses in plaintext';
COMMENT ON COLUMN "messages"."headers" IS 'Custom email header JSON object; must be empty in the plaintext fields of sensitive messages';
COMMENT ON COLUMN "messages"."in_reply_to" IS 'RFC Message-ID of the message being replied to; null in sensitive message plaintext';
COMMENT ON COLUMN "messages"."references_ids" IS 'Ordered array of conversation RFC Message-IDs; empty in sensitive message plaintext';
COMMENT ON COLUMN "messages"."attachment_snapshot" IS 'Attachment metadata JSON array captured for sending, including file IDs, names, types, byte sizes, digests and object keys; sensitive filenames are redacted';
COMMENT ON COLUMN "messages"."sender_snapshot" IS 'Sender identity JSON snapshot, including fromEmail and fromName; sensitive display names are redacted';
COMMENT ON COLUMN "messages"."content_policy" IS 'Content policy: normal or sensitive (encrypted with a deadline); sensitive messages require send_before';
COMMENT ON COLUMN "messages"."send_before" IS 'Absolute sending submission deadline (timestamptz); forbids decryption and new submissions after expiry; required for sensitive messages';
COMMENT ON COLUMN "messages"."sensitive_content" IS 'Envelope-encrypted JSON containing sensitive bodies, subject, display names, headers and metadata; must be null for normal messages';
COMMENT ON COLUMN "messages"."sensitive_content_purged_at" IS 'Sensitive ciphertext purge time (timestamptz); sending content cannot be recovered afterward';
COMMENT ON COLUMN "messages"."idempotency_key" IS 'Caller-supplied message idempotency key, unique within the service';
COMMENT ON COLUMN "messages"."payload_hash" IS 'Canonical request digest: SHA-256 for normal messages, keyed digest for sensitive messages';
COMMENT ON COLUMN "messages"."payload_hash_key_version" IS 'Master key version used for the sensitive request digest; may be null for normal messages';
COMMENT ON COLUMN "messages"."reference_id" IS 'Caller business reference for lookup; does not provide idempotency';
COMMENT ON COLUMN "messages"."metadata" IS 'Caller business metadata JSON object; must be empty in sensitive message plaintext';
COMMENT ON COLUMN "messages"."recipient_count" IS 'Total primary, carbon-copy and blind-copy recipients; must be positive';
COMMENT ON COLUMN "messages"."subject" IS 'Email subject; fixed to [Sensitive content] in sensitive message plaintext and may be cleared after content purge';
COMMENT ON COLUMN "messages"."html_body" IS 'Normal message HTML body; must be null in sensitive message plaintext';
COMMENT ON COLUMN "messages"."text_body" IS 'Normal message plain-text body; must be null in sensitive message plaintext';
COMMENT ON COLUMN "messages"."message_category" IS 'Optional business message classification retained for reporting';
COMMENT ON COLUMN "messages"."reply_to" IS 'JSON array of reply addresses with email and optional name; empty in sensitive message plaintext';
COMMENT ON COLUMN "messages"."provider_tags" IS 'Provider tag JSON object; must be empty in sensitive message plaintext';
COMMENT ON COLUMN "messages"."accepted_at" IS 'System message acceptance time (timestamptz, defaults to database transaction time); distinct from provider acceptance';
COMMENT ON COLUMN "messages"."updated_at" IS 'Last update time (timestamptz); explicitly maintained by business writes, defaults to now()';
COMMENT ON TABLE "outbound_changes" IS 'Content-free committed outbound event references for incremental reconciliation';
COMMENT ON COLUMN "outbound_changes"."service_id" IS 'Owning Service; composite primary key with position';
COMMENT ON COLUMN "outbound_changes"."position" IS 'Per-Service committed stream position independent of provider occurrence time';
COMMENT ON COLUMN "outbound_changes"."id" IS 'Canonical delivery or submission event identifier';
COMMENT ON COLUMN "outbound_changes"."message_id" IS 'Owning outbound message';
COMMENT ON COLUMN "outbound_changes"."type" IS 'Canonical event type';
COMMENT ON COLUMN "outbound_changes"."recorded_at" IS 'Local insertion time used for 90-day prefix retention';
COMMENT ON TABLE "outbound_files" IS 'Service-uploaded outbound attachment metadata; private objects require successful safety scanning and domain authorization before use';
COMMENT ON COLUMN "outbound_files"."id" IS 'Unique outbound attachment identifier';
COMMENT ON COLUMN "outbound_files"."service_id" IS 'Service that uploaded and owns this file';
COMMENT ON COLUMN "outbound_files"."sending_domain_id" IS 'Bound sending domain, checked against current permissions when used';
COMMENT ON COLUMN "outbound_files"."file_name" IS 'Original attachment filename; requires safe encoding in download response headers';
COMMENT ON COLUMN "outbound_files"."content_type" IS 'Declared MIME type; does not establish safety';
COMMENT ON COLUMN "outbound_files"."size_bytes" IS 'File content size in bytes; must be positive';
COMMENT ON COLUMN "outbound_files"."sha256" IS 'Upload-time hexadecimal SHA-256 content digest; the safety scan must match it';
COMMENT ON COLUMN "outbound_files"."object_key" IS 'Globally unique private object storage key, not a public download URL';
COMMENT ON COLUMN "outbound_files"."content_purged_at" IS 'Irreversible content purge time (timestamptz); a non-null value prevents content reads while retaining business metadata';
COMMENT ON COLUMN "outbound_files"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON TABLE "outbound_streams" IS 'Service-owned committed outbound change prefix and retention boundary';
COMMENT ON COLUMN "outbound_streams"."service_id" IS 'Owning Service and primary key';
COMMENT ON COLUMN "outbound_streams"."generation" IS 'Stream identity rejecting cursors from replaced streams';
COMMENT ON COLUMN "outbound_streams"."position" IS 'Latest per-Service bigint position allocated under a transaction row lock';
COMMENT ON COLUMN "outbound_streams"."floor" IS 'Last removed prefix position; cursors below it require reconciliation';
COMMENT ON TABLE "outbox_events" IS 'Transactional outbox writing business state and asynchronous work in one database transaction before reliable queue publication';
COMMENT ON COLUMN "outbox_events"."id" IS 'Unique transactional outbox event identifier';
COMMENT ON COLUMN "outbox_events"."aggregate_type" IS 'Business aggregate type owning the event';
COMMENT ON COLUMN "outbox_events"."aggregate_id" IS 'Business aggregate identifier owning the event';
COMMENT ON COLUMN "outbox_events"."event_type" IS 'Asynchronous business event type to publish';
COMMENT ON COLUMN "outbox_events"."payload" IS 'Queue task JSON containing required business identifiers and parameters; excludes authentication secrets and unnecessary sensitive bodies';
COMMENT ON COLUMN "outbox_events"."status" IS 'Publication status: pending, published or failed';
COMMENT ON COLUMN "outbox_events"."attempt_count" IS 'Cumulative queue publication attempt count';
COMMENT ON COLUMN "outbox_events"."available_at" IS 'Earliest publication time (timestamptz), used for delayed work and retry backoff';
COMMENT ON COLUMN "outbox_events"."published_at" IS 'Successful queue publication time (timestamptz)';
COMMENT ON COLUMN "outbox_events"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON TABLE "pending_object_deletions" IS 'Object upload compensation and deferred deletion tasks; cleared on business commit, with abandoned objects removed after their deadline';
COMMENT ON COLUMN "pending_object_deletions"."object_key" IS 'Private object storage key pending compensating cleanup; one task per key';
COMMENT ON COLUMN "pending_object_deletions"."available_at" IS 'Earliest deletion time (timestamptz); defaults to ten minutes after transaction start to allow business commit';
COMMENT ON COLUMN "pending_object_deletions"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON COLUMN "pending_object_deletions"."last_error" IS 'Latest redacted object deletion failure description';
COMMENT ON COLUMN "pending_object_deletions"."attempt_count" IS 'Non-negative deletion attempt count';
COMMENT ON TABLE "provider_accounts" IS 'Email provider accounts and non-secret configuration; authentication secrets are encrypted in a separate credentials table';
COMMENT ON COLUMN "provider_accounts"."id" IS 'Unique provider account identifier';
COMMENT ON COLUMN "provider_accounts"."type" IS 'Provider type: resend, ses, sendgrid, mailgun, postmark or mock';
COMMENT ON COLUMN "provider_accounts"."name" IS 'Globally unique provider account name';
COMMENT ON COLUMN "provider_accounts"."status" IS 'Account status: active (available), disabled or degraded (configuration or health issue)';
COMMENT ON COLUMN "provider_accounts"."public_config" IS 'Non-secret provider configuration JSON; type-specific regions, configuration sets and message streams; must not contain authentication secrets';
COMMENT ON COLUMN "provider_accounts"."config_schema_version" IS 'Configuration schema version used to parse public_config';
COMMENT ON COLUMN "provider_accounts"."health" IS 'Provider health check JSON including capabilities and identity diagnostics; initial status is unknown';
COMMENT ON COLUMN "provider_accounts"."quota" IS 'Provider quota snapshot JSON containing limits and usage; an empty object means no snapshot is available';
COMMENT ON COLUMN "provider_accounts"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON COLUMN "provider_accounts"."updated_at" IS 'Last update time (timestamptz); explicitly maintained by business writes, defaults to now()';
COMMENT ON TABLE "provider_credentials" IS 'Versioned, envelope-encrypted provider authentication credentials; at most one active version per account';
COMMENT ON COLUMN "provider_credentials"."id" IS 'Unique provider credential identifier';
COMMENT ON COLUMN "provider_credentials"."provider_account_id" IS 'Provider account that owns this credential';
COMMENT ON COLUMN "provider_credentials"."credential_version" IS 'Positive credential version, unique within the provider account';
COMMENT ON COLUMN "provider_credentials"."secret_ciphertext" IS 'Encrypted provider authentication configuration; plaintext API keys, tokens and access keys must never be stored here';
COMMENT ON COLUMN "provider_credentials"."encrypted_dek" IS 'Data encryption key (DEK) encrypted with the master key; required to decrypt secret_ciphertext';
COMMENT ON COLUMN "provider_credentials"."key_version" IS 'Version of the master key wrapping the DEK, used for key rotation';
COMMENT ON COLUMN "provider_credentials"."status" IS 'Credential status: active (currently valid) or revoked';
COMMENT ON COLUMN "provider_credentials"."valid_from" IS 'Credential validity start time (timestamptz)';
COMMENT ON COLUMN "provider_credentials"."valid_to" IS 'Credential validity end time (timestamptz); null means no configured expiration';
COMMENT ON COLUMN "provider_credentials"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON COLUMN "provider_credentials"."created_by" IS 'Actor that created this credential, for tracing secret changes';
COMMENT ON TABLE "provider_identities" IS 'Domain sending identities within provider accounts and their DNS verification status';
COMMENT ON COLUMN "provider_identities"."id" IS 'Unique provider sending identity identifier';
COMMENT ON COLUMN "provider_identities"."sending_domain_id" IS 'Managed email domain represented by this identity';
COMMENT ON COLUMN "provider_identities"."provider_account_id" IS 'Provider account that owns this identity';
COMMENT ON COLUMN "provider_identities"."external_identity_id" IS 'Provider-side identity identifier; may be null before a remote identity is created';
COMMENT ON COLUMN "provider_identities"."status" IS 'Identity status: pending (awaiting verification), verified, failed or disabled';
COMMENT ON COLUMN "provider_identities"."dns_records" IS 'JSON array of required DNS records, including names, types, values and verification details; empty when unavailable';
COMMENT ON COLUMN "provider_identities"."last_checked_at" IS 'Last provider identity verification check (timestamptz)';
COMMENT ON COLUMN "provider_identities"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON COLUMN "provider_identities"."updated_at" IS 'Last update time (timestamptz); explicitly maintained by business writes, defaults to now()';
COMMENT ON TABLE "provider_webhook_endpoints" IS 'Provider inbound webhook endpoints and encrypted verification configuration; at most one endpoint per provider account';
COMMENT ON COLUMN "provider_webhook_endpoints"."id" IS 'Unique provider webhook endpoint identifier';
COMMENT ON COLUMN "provider_webhook_endpoints"."provider_account_id" IS 'Provider account that owns this endpoint';
COMMENT ON COLUMN "provider_webhook_endpoints"."opaque_token" IS 'Unguessable webhook URL routing token; does not replace provider signature verification';
COMMENT ON COLUMN "provider_webhook_endpoints"."security_config_ciphertext" IS 'Encrypted webhook signature verification or authentication configuration; null when unconfigured';
COMMENT ON COLUMN "provider_webhook_endpoints"."security_encrypted_dek" IS 'Encrypted DEK paired with the webhook security configuration ciphertext';
COMMENT ON COLUMN "provider_webhook_endpoints"."key_version" IS 'Master key version wrapping the webhook security DEK; null when unconfigured';
COMMENT ON COLUMN "provider_webhook_endpoints"."security_version" IS 'Verification configuration revision, captured when receiving events';
COMMENT ON COLUMN "provider_webhook_endpoints"."security_configured" IS 'Whether webhook security configuration is complete';
COMMENT ON COLUMN "provider_webhook_endpoints"."status" IS 'Endpoint status: active (receiving) or disabled';
COMMENT ON COLUMN "provider_webhook_endpoints"."expected_topic_arn" IS 'Allowed SES SNS topic ARN used to restrict notification sources';
COMMENT ON COLUMN "provider_webhook_endpoints"."ip_allowlist" IS 'Allowed source IP addresses or CIDR ranges for providers requiring source address checks';
COMMENT ON COLUMN "provider_webhook_endpoints"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON COLUMN "provider_webhook_endpoints"."updated_at" IS 'Last update time (timestamptz); explicitly maintained by business writes, defaults to now()';
COMMENT ON TABLE "rate_limit_counters" IS 'Atomic database rate limit window counters isolated by scope, business key and window start, with expiry-based cleanup';
COMMENT ON COLUMN "rate_limit_counters"."scope" IS 'Rate limit scope name, such as provider, sending identity or administrative authentication';
COMMENT ON COLUMN "rate_limit_counters"."key" IS 'Limited entity key within the scope; composite primary key with scope and window_start';
COMMENT ON COLUMN "rate_limit_counters"."window_start" IS 'Fixed rate limit window start (timestamptz), bucketed from database time using the configured seconds';
COMMENT ON COLUMN "rate_limit_counters"."count" IS 'Non-negative bigint consumed quota: recipients for sending limits, requests for authentication limits';
COMMENT ON COLUMN "rate_limit_counters"."expires_at" IS 'Counter cleanup eligibility time (timestamptz); retains a short buffer after window end and does not reset the business limit';
COMMENT ON TABLE "raw_provider_events" IS 'Provider webhook receipt evidence and asynchronous processing work; raw payloads, verification evidence and normalized facts follow retention policies';
COMMENT ON COLUMN "raw_provider_events"."content_purged_at" IS 'Irreversible content purge time (timestamptz); a non-null value prevents content reads while retaining business metadata';
COMMENT ON COLUMN "raw_provider_events"."id" IS 'Unique raw provider event identifier';
COMMENT ON COLUMN "raw_provider_events"."provider_account_id" IS 'Provider account receiving this event';
COMMENT ON COLUMN "raw_provider_events"."webhook_endpoint_id" IS 'Provider webhook endpoint that received this event';
COMMENT ON COLUMN "raw_provider_events"."provider_event_id" IS 'Native provider event identifier; deduplicated with the provider account when present';
COMMENT ON COLUMN "raw_provider_events"."native_type" IS 'Native provider event type name';
COMMENT ON COLUMN "raw_provider_events"."signature_valid" IS 'Whether the signature or equivalent source authentication was valid at receipt';
COMMENT ON COLUMN "raw_provider_events"."replay_valid" IS 'Whether timestamp, token or equivalent replay checks passed at receipt';
COMMENT ON COLUMN "raw_provider_events"."payload_expires_at" IS 'Retention deadline for raw payload and verification evidence (timestamptz)';
COMMENT ON COLUMN "raw_provider_events"."raw_payload_purged_at" IS 'Raw payload purge time (timestamptz); does not imply all business metadata has been purged';
COMMENT ON COLUMN "raw_provider_events"."normalized_events" IS 'JSON array of normalized provider events for asynchronous processing; may contain business content subject to retention';
COMMENT ON COLUMN "raw_provider_events"."raw_body" IS 'Original HTTP request body bytes for signature verification and reprocessing; may be replaced by an object reference or purged by policy';
COMMENT ON COLUMN "raw_provider_events"."raw_object_key" IS 'Private object storage key for the original request body; contains no public access credentials';
COMMENT ON COLUMN "raw_provider_events"."headers" IS 'Received HTTP headers as JSON; sensitive information follows security and retention policies';
COMMENT ON COLUMN "raw_provider_events"."received_at" IS 'System webhook receipt time (timestamptz, defaults to database transaction time)';
COMMENT ON COLUMN "raw_provider_events"."processed_at" IS 'Successful asynchronous event processing completion time (timestamptz)';
COMMENT ON COLUMN "raw_provider_events"."terminated_at" IS 'Manual or system processing termination time (timestamptz); non-null stops automatic retries';
COMMENT ON COLUMN "raw_provider_events"."processing_error" IS 'Latest redacted processing failure description';
COMMENT ON COLUMN "raw_provider_events"."verification" IS 'Envelope-encrypted verification evidence JSON bound to the raw event identifier; plaintext authentication secrets are forbidden';
COMMENT ON COLUMN "raw_provider_events"."security_version" IS 'Webhook security configuration version captured when receiving the event';
COMMENT ON COLUMN "raw_provider_events"."processing_attempt_count" IS 'Non-negative asynchronous processing attempt count';
COMMENT ON COLUMN "raw_provider_events"."next_attempt_at" IS 'Earliest next asynchronous processing time (timestamptz)';
COMMENT ON TABLE "request_logs" IS 'Service API request traces linking request identifiers to responses, duration and business resources';
COMMENT ON COLUMN "request_logs"."id" IS 'Database-generated bigint request log sequence number';
COMMENT ON COLUMN "request_logs"."request_id" IS 'Globally unique API request trace identifier';
COMMENT ON COLUMN "request_logs"."service_id" IS 'Authenticated service; null for anonymous requests or after service deletion';
COMMENT ON COLUMN "request_logs"."message_id" IS 'Associated outbound message; null when absent or after message deletion';
COMMENT ON COLUMN "request_logs"."method" IS 'HTTP request method';
COMMENT ON COLUMN "request_logs"."path" IS 'HTTP request path; must not include authentication secrets';
COMMENT ON COLUMN "request_logs"."status_code" IS 'HTTP response status code';
COMMENT ON COLUMN "request_logs"."duration_ms" IS 'Request processing duration in milliseconds';
COMMENT ON COLUMN "request_logs"."actor" IS 'Request actor identifier; null when unknown';
COMMENT ON COLUMN "request_logs"."details" IS 'Request diagnostic JSON containing only permitted redacted information; Authorization, credentials and sensitive bodies are forbidden';
COMMENT ON COLUMN "request_logs"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON TABLE "sending_domains" IS 'Managed email domains shared by service bindings; inbound mail routes by recipient domain';
COMMENT ON COLUMN "sending_domains"."id" IS 'Unique email domain identifier';
COMMENT ON COLUMN "sending_domains"."domain" IS 'Globally unique normalized email domain';
COMMENT ON COLUMN "sending_domains"."status" IS 'Domain status: active (available) or disabled';
COMMENT ON COLUMN "sending_domains"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON COLUMN "sending_domains"."updated_at" IS 'Last update time (timestamptz); explicitly maintained by business writes, defaults to now()';
COMMENT ON TABLE "service_credentials" IS 'Service API credentials storing only a key digest and display prefix, never the original API key';
COMMENT ON COLUMN "service_credentials"."id" IS 'Unique API credential identifier';
COMMENT ON COLUMN "service_credentials"."service_id" IS 'Service that owns this credential';
COMMENT ON COLUMN "service_credentials"."key_prefix" IS 'Display prefix for identifying the credential; insufficient for authentication';
COMMENT ON COLUMN "service_credentials"."key_hash" IS 'Globally unique, irreversible API key digest used to verify the original key';
COMMENT ON COLUMN "service_credentials"."status" IS 'Credential status: active (valid) or revoked';
COMMENT ON COLUMN "service_credentials"."valid_from" IS 'Credential validity start time (timestamptz)';
COMMENT ON COLUMN "service_credentials"."valid_to" IS 'Credential validity end time (timestamptz); null means no configured expiration';
COMMENT ON COLUMN "service_credentials"."last_used_at" IS 'Last successful use of this credential (timestamptz)';
COMMENT ON COLUMN "service_credentials"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON TABLE "service_domain_bindings" IS 'Service and domain associations; receiving can fan out to multiple services and each service chooses its own outbound identity';
COMMENT ON COLUMN "service_domain_bindings"."id" IS 'Unique service-domain binding identifier';
COMMENT ON COLUMN "service_domain_bindings"."service_id" IS 'Service bound to the domain';
COMMENT ON COLUMN "service_domain_bindings"."sending_domain_id" IS 'Bound email domain';
COMMENT ON COLUMN "service_domain_bindings"."receive_enabled" IS 'Whether this service receives a private copy of inbound mail for the domain';
COMMENT ON COLUMN "service_domain_bindings"."outbound_provider_identity_id" IS 'Provider sending identity for this service and domain; null disables sending';
COMMENT ON COLUMN "service_domain_bindings"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON COLUMN "service_domain_bindings"."updated_at" IS 'Last update time (timestamptz); explicitly maintained by business writes, defaults to now()';
COMMENT ON TABLE "services" IS 'Calling services; isolation boundary for API credentials, messages and send/receive permissions';
COMMENT ON COLUMN "services"."id" IS 'Unique service identifier';
COMMENT ON COLUMN "services"."name" IS 'Globally unique service name, compared case-insensitively';
COMMENT ON COLUMN "services"."status" IS 'Service status: active (available) or suspended (paused)';
COMMENT ON COLUMN "services"."suppression_management_allowed" IS 'Whether the service API may manage its own suppression rules; denied by default';
COMMENT ON COLUMN "services"."configuration_revision" IS 'Positive configuration revision used for optimistic concurrency checks';
COMMENT ON COLUMN "services"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON COLUMN "services"."updated_at" IS 'Last update time (timestamptz); explicitly maintained by business writes, defaults to now()';
COMMENT ON TABLE "submission_attempts" IS 'Individual provider sending attempts and evidence, retaining routing decisions, idempotency, outcome certainty and reconciliation details';
COMMENT ON COLUMN "submission_attempts"."id" IS 'Unique provider submission attempt identifier';
COMMENT ON COLUMN "submission_attempts"."submission_id" IS 'Owning sending submission identifier';
COMMENT ON COLUMN "submission_attempts"."attempt_number" IS 'Attempt sequence starting at one, unique within the submission';
COMMENT ON COLUMN "submission_attempts"."provider_account_id" IS 'Provider account actually used for this attempt';
COMMENT ON COLUMN "submission_attempts"."provider_identity_id" IS 'Provider sending identity actually used for this attempt';
COMMENT ON COLUMN "submission_attempts"."routing_snapshot" IS 'Routing decision JSON snapshot with matched policy, selected target, candidates, exclusions, selection time and recipient count';
COMMENT ON COLUMN "submission_attempts"."request_fingerprint" IS 'Provider request digest: SHA-256 for normal content or a keyed digest for sensitive content; avoids retaining the plaintext request';
COMMENT ON COLUMN "submission_attempts"."provider_idempotency_key" IS 'Request key sent to providers supporting native idempotency; null when unsupported';
COMMENT ON COLUMN "submission_attempts"."external_message_id" IS 'Provider-returned message identifier, unique within the provider account';
COMMENT ON COLUMN "submission_attempts"."rfc_message_id" IS 'RFC Message-ID used in the request or confirmed by the provider, for conversation and evidence correlation';
COMMENT ON COLUMN "submission_attempts"."status" IS 'Attempt status: submitting, accepted, failed (definite failure), unknown (indeterminate outcome), reconciling or reconciled';
COMMENT ON COLUMN "submission_attempts"."outcome_determinate" IS 'Whether explicit evidence confirms the provider acceptance outcome; indeterminate outcomes must not trigger blind resends';
COMMENT ON COLUMN "submission_attempts"."error_category" IS 'Normalized provider error category; null when no error exists';
COMMENT ON COLUMN "submission_attempts"."error_code" IS 'Normalized or provider-specific error code; null when no error exists';
COMMENT ON COLUMN "submission_attempts"."error_message" IS 'Redacted error description; must not contain authentication secrets or sensitive message bodies';
COMMENT ON COLUMN "submission_attempts"."diagnostic" IS 'Redacted provider diagnostic JSON for protocol, network or response failures';
COMMENT ON COLUMN "submission_attempts"."provider_response_ref" IS 'Reference to provider response evidence; does not store secret response content directly';
COMMENT ON COLUMN "submission_attempts"."started_at" IS 'Attempt start time (timestamptz, defaults to database transaction time)';
COMMENT ON COLUMN "submission_attempts"."finished_at" IS 'Attempt completion or outcome confirmation time (timestamptz)';
COMMENT ON COLUMN "submission_attempts"."submission_deadline_at" IS 'Deadline for the submission result (timestamptz); defaults to two minutes after transaction start, used for recovery and reconciliation';
COMMENT ON COLUMN "submission_attempts"."retry_authorized_at" IS 'Manual or business retry authorization time (timestamptz); null means not authorized';
COMMENT ON COLUMN "submission_attempts"."retry_authorized_by" IS 'Actor that authorized the retry';
COMMENT ON COLUMN "submission_attempts"."reconciliation_count" IS 'Non-negative number of completed reconciliation attempts';
COMMENT ON COLUMN "submission_attempts"."reconcile_after" IS 'Earliest next reconciliation time (timestamptz); null when unscheduled';
COMMENT ON TABLE "submission_deliveries" IS 'Association between sending submissions and recipient deliveries; one submission may contain multiple recipients';
COMMENT ON COLUMN "submission_deliveries"."submission_id" IS 'Sending submission identifier; part of the composite primary key with delivery_id';
COMMENT ON COLUMN "submission_deliveries"."delivery_id" IS 'Recipient delivery identifier; part of the composite primary key with submission_id';
COMMENT ON TABLE "submission_events" IS 'Canonical sending submission evidence used for acceptance confirmation, recovery and reconciliation';
COMMENT ON COLUMN "submission_events"."id" IS 'Unique submission event identifier';
COMMENT ON COLUMN "submission_events"."submission_id" IS 'Sending submission associated with this event';
COMMENT ON COLUMN "submission_events"."raw_provider_event_id" IS 'Source raw provider event; null for internal events or after source deletion';
COMMENT ON COLUMN "submission_events"."attempt_id" IS 'Optional provider submission attempt associated with the event';
COMMENT ON COLUMN "submission_events"."event_type" IS 'Canonical submission event type describing submission, acceptance, failure or reconciliation facts';
COMMENT ON COLUMN "submission_events"."source_key" IS 'Globally unique submission event source deduplication key';
COMMENT ON COLUMN "submission_events"."occurred_at" IS 'Actual event time (timestamptz), distinct from database insertion time';
COMMENT ON COLUMN "submission_events"."canonical_payload" IS 'Canonical submission event JSON retaining event content and evidence metadata';
COMMENT ON COLUMN "submission_events"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON TABLE "submissions" IS 'Outbound sending units grouping recipients and traceable provider submission attempts';
COMMENT ON COLUMN "submissions"."id" IS 'Unique sending submission identifier';
COMMENT ON COLUMN "submissions"."message_id" IS 'Owning outbound message identifier';
COMMENT ON COLUMN "submissions"."status" IS 'Submission status: queued, submitting, accepted, deferred, unknown (indeterminate outcome), failed or canceled';
COMMENT ON COLUMN "submissions"."current_attempt_id" IS 'Current provider submission attempt; set to null if that attempt is deleted';
COMMENT ON COLUMN "submissions"."defer_count" IS 'Non-negative cumulative number of submission deferrals';
COMMENT ON COLUMN "submissions"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON COLUMN "submissions"."updated_at" IS 'Last update time (timestamptz); explicitly maintained by business writes, defaults to now()';
COMMENT ON TABLE "suppressions" IS 'Email sending suppression rules at global, service and service-specific list scopes';
COMMENT ON COLUMN "suppressions"."id" IS 'Unique suppression rule identifier';
COMMENT ON COLUMN "suppressions"."scope_type" IS 'Scope type: global, service or list; determines required and forbidden service/list identifiers';
COMMENT ON COLUMN "suppressions"."service_id" IS 'Owning service; must be null for global scope and present for service/list scopes';
COMMENT ON COLUMN "suppressions"."list_id" IS 'Service-specific business list identifier; required only for list scope and null otherwise';
COMMENT ON COLUMN "suppressions"."email_normalized" IS 'Lowercase email address enforced by the database, unique within the active scope';
COMMENT ON COLUMN "suppressions"."reason" IS 'Suppression reason, such as bounce, complaint, unsubscribe or manual action';
COMMENT ON COLUMN "suppressions"."source" IS 'Suppression source identifier tracing provider events or manual actions';
COMMENT ON COLUMN "suppressions"."bounce_count" IS 'Cumulative bounce count for this rule, used in bounce suppression decisions';
COMMENT ON COLUMN "suppressions"."active" IS 'Whether the rule is enabled; at most one active rule per email and scope';
COMMENT ON COLUMN "suppressions"."expires_at" IS 'Rule expiration time (timestamptz); null means no time-based expiration';
COMMENT ON COLUMN "suppressions"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON COLUMN "suppressions"."updated_at" IS 'Last update time (timestamptz); explicitly maintained by business writes, defaults to now()';
COMMENT ON TABLE "worker_heartbeats" IS 'Asynchronous worker liveness heartbeats used by health checks to detect recent activity';
COMMENT ON COLUMN "worker_heartbeats"."worker_id" IS 'Unique worker instance identifier';
COMMENT ON COLUMN "worker_heartbeats"."last_seen_at" IS 'Latest heartbeat time (timestamptz); indicates liveness, not process start time';
