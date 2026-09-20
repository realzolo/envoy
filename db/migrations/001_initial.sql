CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE products (
  id text PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE services (
  id text PRIMARY KEY, product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  rate_limit_per_minute integer NOT NULL DEFAULT 600 CHECK (rate_limit_per_minute > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE service_credentials (
  id text PRIMARY KEY, service_id text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  key_prefix text NOT NULL, key_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  valid_from timestamptz NOT NULL DEFAULT now(), valid_to timestamptz, last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE templates (
  id text PRIMARY KEY, product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  key text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'transactional', created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(product_id, key)
);

CREATE TABLE template_versions (
  id text PRIMARY KEY, template_id text NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  subject_template text NOT NULL, html_template text NOT NULL, text_template text NOT NULL,
  variables_schema jsonb NOT NULL DEFAULT '{}'::jsonb, sample_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
  UNIQUE(template_id, version)
);
CREATE UNIQUE INDEX template_versions_one_published ON template_versions(template_id) WHERE status = 'published';

CREATE TABLE provider_accounts (
  id text PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('resend', 'ses', 'sendgrid', 'mailgun', 'postmark', 'mock')),
  name text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'degraded')),
  region text NOT NULL, public_config jsonb NOT NULL, config_schema_version integer NOT NULL DEFAULT 1,
  config_revision integer NOT NULL DEFAULT 1, health jsonb NOT NULL DEFAULT '{"status":"unknown"}'::jsonb,
  quota jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_credentials (
  id text PRIMARY KEY, provider_account_id text NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  credential_version integer NOT NULL CHECK (credential_version > 0), secret_ciphertext text NOT NULL,
  encrypted_dek text NOT NULL, key_version text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  valid_from timestamptz NOT NULL DEFAULT now(), valid_to timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL, UNIQUE(provider_account_id, credential_version)
);
CREATE UNIQUE INDEX provider_credentials_one_active ON provider_credentials(provider_account_id) WHERE status = 'active';

CREATE TABLE provider_webhook_endpoints (
  id text PRIMARY KEY, provider_account_id text NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  opaque_token text NOT NULL UNIQUE, security_config_ciphertext text, security_encrypted_dek text, key_version text,
  security_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  expected_topic_arn text, ip_allowlist text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sending_domains (
  id text PRIMARY KEY, domain text NOT NULL UNIQUE, region text NOT NULL, inbound_enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_identities (
  id text PRIMARY KEY, sending_domain_id text NOT NULL REFERENCES sending_domains(id) ON DELETE CASCADE,
  provider_account_id text NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  external_identity_id text, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'disabled')),
  dns_records jsonb NOT NULL DEFAULT '[]'::jsonb, last_checked_at timestamptz,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(sending_domain_id, provider_account_id),
  UNIQUE(id, provider_account_id)
);

CREATE TABLE sender_profiles (
  id text PRIMARY KEY, product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sending_domain_id text NOT NULL REFERENCES sending_domains(id) ON DELETE RESTRICT,
  name text NOT NULL, from_name text NOT NULL, from_local_part text NOT NULL, reply_to text,
  message_category text NOT NULL DEFAULT 'transactional',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(product_id, message_category, from_local_part)
);

CREATE TABLE routing_policies (
  id text PRIMARY KEY, name text NOT NULL, product_id text REFERENCES products(id) ON DELETE CASCADE,
  service_id text REFERENCES services(id) ON DELETE CASCADE, template_id text REFERENCES templates(id) ON DELETE CASCADE,
  message_category text, destination_region text, priority integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE routing_targets (
  id text PRIMARY KEY, policy_id text NOT NULL REFERENCES routing_policies(id) ON DELETE CASCADE,
  provider_account_id text NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  provider_identity_id text NOT NULL REFERENCES provider_identities(id) ON DELETE RESTRICT,
  priority integer NOT NULL DEFAULT 100, weight integer NOT NULL DEFAULT 100 CHECK (weight > 0),
  rate_limit_per_minute integer NOT NULL DEFAULT 1000 CHECK (rate_limit_per_minute > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'circuit_open')),
  circuit_open_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(provider_identity_id, provider_account_id) REFERENCES provider_identities(id, provider_account_id) ON DELETE RESTRICT
);

CREATE TABLE messages (
  id text PRIMARY KEY, product_id text NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  service_id text NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  sender_profile_id text NOT NULL REFERENCES sender_profiles(id) ON DELETE RESTRICT,
  template_id text NOT NULL REFERENCES templates(id) ON DELETE RESTRICT,
  template_version_id text NOT NULL REFERENCES template_versions(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL, payload_hash text NOT NULL, reference_id text, locale text NOT NULL,
  variables jsonb NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  recipient_count integer NOT NULL CHECK (recipient_count > 0), accepted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(service_id, idempotency_key)
);

CREATE TABLE deliveries (
  id text PRIMARY KEY, message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_email text NOT NULL, recipient_name text,
  lifecycle_status text NOT NULL DEFAULT 'queued' CHECK (lifecycle_status IN ('queued','submitting','accepted','deferred','delivered','bounced','failed','unknown')),
  engagement_status text NOT NULL DEFAULT 'unopened' CHECK (engagement_status IN ('unopened','opened','clicked')),
  compliance_status text NOT NULL DEFAULT 'clean' CHECK (compliance_status IN ('clean','complained','unsubscribed','suppressed')),
  current_attempt_id text, queued_at timestamptz NOT NULL DEFAULT now(), accepted_at timestamptz,
  delivered_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(message_id, recipient_email)
);

CREATE TABLE delivery_attempts (
  id text PRIMARY KEY, delivery_id text NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL, provider_account_id text NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  provider_identity_id text NOT NULL REFERENCES provider_identities(id) ON DELETE RESTRICT,
  routing_snapshot jsonb NOT NULL, request_fingerprint text NOT NULL, provider_idempotency_key text,
  external_message_id text, status text NOT NULL CHECK (status IN ('submitting','accepted','failed','unknown','reconciling','reconciled')),
  outcome_determinate boolean NOT NULL DEFAULT false, error_category text, error_code text, error_message text,
  provider_response_ref text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE(delivery_id, attempt_number), UNIQUE(provider_account_id, external_message_id)
);
ALTER TABLE deliveries ADD CONSTRAINT deliveries_current_attempt_fk FOREIGN KEY (current_attempt_id) REFERENCES delivery_attempts(id) ON DELETE SET NULL;

CREATE TABLE raw_provider_events (
  id text PRIMARY KEY, provider_account_id text NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  webhook_endpoint_id text NOT NULL REFERENCES provider_webhook_endpoints(id) ON DELETE RESTRICT,
  provider_event_id text, native_type text NOT NULL, signature_valid boolean NOT NULL, replay_valid boolean NOT NULL,
  raw_body bytea, raw_object_key text, headers jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz, processing_error text, UNIQUE(provider_account_id, provider_event_id)
);

CREATE TABLE delivery_events (
  id text PRIMARY KEY, delivery_id text NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  raw_provider_event_id text REFERENCES raw_provider_events(id) ON DELETE SET NULL,
  event_type text NOT NULL, occurred_at timestamptz NOT NULL, canonical_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(delivery_id, event_type, occurred_at)
);

CREATE TABLE suppressions (
  id text PRIMARY KEY, scope_type text NOT NULL CHECK (scope_type IN ('global','product','list')),
  product_id text REFERENCES products(id) ON DELETE CASCADE, list_id text, email_normalized text NOT NULL,
  reason text NOT NULL, source text NOT NULL, bounce_count integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true,
  expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX suppressions_active_scope ON suppressions(scope_type, COALESCE(product_id, '*'), COALESCE(list_id, '*'), email_normalized) WHERE active = true;

CREATE TABLE callback_endpoints (
  id text PRIMARY KEY, service_id text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name text NOT NULL, url text NOT NULL, secret_ciphertext text NOT NULL, encrypted_dek text NOT NULL,
  key_version text NOT NULL, secret_version integer NOT NULL DEFAULT 1, subscribed_events text[] NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inbound_routes (
  id text PRIMARY KEY, provider_webhook_endpoint_id text NOT NULL REFERENCES provider_webhook_endpoints(id) ON DELETE CASCADE,
  sending_domain_id text NOT NULL REFERENCES sending_domains(id) ON DELETE CASCADE,
  local_part_pattern text NOT NULL DEFAULT '*', product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  service_id text REFERENCES services(id) ON DELETE CASCADE,
  callback_endpoint_id text REFERENCES callback_endpoints(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')), created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inbound_messages (
  id text PRIMARY KEY, inbound_route_id text REFERENCES inbound_routes(id) ON DELETE SET NULL,
  product_id text REFERENCES products(id) ON DELETE SET NULL, service_id text REFERENCES services(id) ON DELETE SET NULL,
  provider_account_id text NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  raw_provider_event_id text REFERENCES raw_provider_events(id) ON DELETE SET NULL,
  external_message_id text, message_id text, from_email text NOT NULL, to_emails text[] NOT NULL,
  cc_emails text[] NOT NULL DEFAULT '{}', bcc_emails text[] NOT NULL DEFAULT '{}', subject text NOT NULL,
  sanitized_html text, text_body text, raw_mime_object_key text,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','scanning','ready','rejected','delivered')),
  rejection_reason text, received_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_account_id, external_message_id)
);

CREATE TABLE inbound_attachments (
  id text PRIMARY KEY, inbound_message_id text NOT NULL REFERENCES inbound_messages(id) ON DELETE CASCADE,
  file_name text NOT NULL, content_type text NOT NULL, size_bytes bigint NOT NULL, object_key text NOT NULL,
  content_id text, scan_status text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','infected','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE callback_deliveries (
  id text PRIMARY KEY, endpoint_id text NOT NULL REFERENCES callback_endpoints(id) ON DELETE CASCADE,
  delivery_event_id text REFERENCES delivery_events(id) ON DELETE SET NULL,
  inbound_message_id text REFERENCES inbound_messages(id) ON DELETE SET NULL,
  event_type text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivering','delivered','retrying','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0, response_code integer, last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  id text PRIMARY KEY, aggregate_type text NOT NULL, aggregate_id text NOT NULL, event_type text NOT NULL,
  payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','failed')),
  attempt_count integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, resource_type text NOT NULL,
  resource_id text, details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE config_revisions (
  id bigserial PRIMARY KEY, resource_type text NOT NULL, resource_id text NOT NULL, revision integer NOT NULL,
  config jsonb NOT NULL, actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(resource_type, resource_id, revision)
);

CREATE TABLE workspace_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE request_logs (
  id bigserial PRIMARY KEY, request_id text NOT NULL, method text NOT NULL, path text NOT NULL,
  status_code integer NOT NULL, duration_ms integer NOT NULL, actor text, details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_accepted_idx ON messages(accepted_at DESC);
CREATE INDEX deliveries_lifecycle_idx ON deliveries(lifecycle_status, queued_at DESC);
CREATE INDEX attempts_external_idx ON delivery_attempts(provider_account_id, external_message_id);
CREATE INDEX raw_provider_events_pending_idx ON raw_provider_events(processed_at, received_at);
CREATE INDEX delivery_events_timeline_idx ON delivery_events(delivery_id, occurred_at DESC);
CREATE INDEX callback_deliveries_pending_idx ON callback_deliveries(status, next_attempt_at);
CREATE INDEX outbox_pending_idx ON outbox_events(status, available_at, created_at);
CREATE INDEX inbound_messages_received_idx ON inbound_messages(received_at DESC);
CREATE INDEX request_logs_created_idx ON request_logs(created_at DESC);
