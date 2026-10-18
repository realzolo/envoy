CREATE
EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE products
(
    id         text PRIMARY KEY,
    name       text        NOT NULL UNIQUE,
    status     text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE services
(
    id                    text PRIMARY KEY,
    product_id            text        NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    name                  text        NOT NULL,
    suppression_management_allowed boolean NOT NULL DEFAULT false,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (product_id, name),
    UNIQUE (id, product_id)
);

CREATE TABLE service_credentials
(
    id           text PRIMARY KEY,
    service_id   text        NOT NULL REFERENCES services (id) ON DELETE CASCADE,
    key_prefix   text        NOT NULL,
    key_hash     text        NOT NULL UNIQUE,
    status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    valid_from   timestamptz NOT NULL DEFAULT now(),
    valid_to     timestamptz,
    last_used_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_accounts
(
    id                    text PRIMARY KEY,
    type                  text        NOT NULL CHECK (type IN ('resend', 'ses', 'sendgrid', 'mailgun', 'postmark', 'mock')),
    name                  text        NOT NULL UNIQUE,
    status                text        NOT NULL DEFAULT 'degraded' CHECK (status IN ('active', 'disabled', 'degraded')),
    public_config         jsonb       NOT NULL,
    config_schema_version integer     NOT NULL DEFAULT 1,
    health                jsonb       NOT NULL DEFAULT '{
      "status": "unknown"
    }'::jsonb,
    quota                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_credentials
(
    id                  text PRIMARY KEY,
    provider_account_id text        NOT NULL REFERENCES provider_accounts (id) ON DELETE CASCADE,
    credential_version  integer     NOT NULL CHECK (credential_version > 0),
    secret_ciphertext   text        NOT NULL,
    encrypted_dek       text        NOT NULL,
    key_version         text        NOT NULL,
    status              text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    valid_from          timestamptz NOT NULL DEFAULT now(),
    valid_to            timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          text        NOT NULL,
    UNIQUE (provider_account_id, credential_version)
);
CREATE UNIQUE INDEX provider_credentials_one_active ON provider_credentials (provider_account_id) WHERE status = 'active';

CREATE TABLE provider_webhook_endpoints
(
    id                         text PRIMARY KEY,
    provider_account_id        text        NOT NULL REFERENCES provider_accounts (id) ON DELETE CASCADE,
    opaque_token               text        NOT NULL UNIQUE,
    security_config_ciphertext text,
    security_encrypted_dek     text,
    key_version                text,
    security_version           integer     NOT NULL DEFAULT 0,
    security_configured        boolean     NOT NULL DEFAULT false,
    status                     text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    expected_topic_arn         text,
    ip_allowlist               text[] NOT NULL DEFAULT '{}',
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider_account_id)
);

CREATE TABLE sending_domains
(
    id         text PRIMARY KEY,
    domain     text        NOT NULL UNIQUE,
    status     text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_identities
(
    id                   text PRIMARY KEY,
    sending_domain_id    text        NOT NULL REFERENCES sending_domains (id) ON DELETE CASCADE,
    provider_account_id  text        NOT NULL REFERENCES provider_accounts (id) ON DELETE CASCADE,
    external_identity_id text,
    status               text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'disabled')),
    dns_records          jsonb       NOT NULL DEFAULT '[]'::jsonb,
    last_checked_at      timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (sending_domain_id, provider_account_id),
    UNIQUE (id, provider_account_id)
);

CREATE TABLE service_domain_grants
(
    id text PRIMARY KEY,
    service_id text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    sending_domain_id text NOT NULL REFERENCES sending_domains(id) ON DELETE CASCADE,
    send_allowed boolean NOT NULL DEFAULT false,
    receive_allowed boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
    revision integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(service_id,sending_domain_id),
    CHECK(send_allowed OR receive_allowed)
);

CREATE TABLE outbound_files
(
    id text PRIMARY KEY,
    service_id text NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
    sending_domain_id text NOT NULL REFERENCES sending_domains(id) ON DELETE RESTRICT,
    file_name text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL CHECK(size_bytes>0),
    sha256 text NOT NULL,
    object_key text NOT NULL UNIQUE,
    content_purged_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE routing_policies
(
    id                 text PRIMARY KEY,
    name               text        NOT NULL,
    product_id         text REFERENCES products (id) ON DELETE CASCADE,
    service_id         text,
    sending_domain_id  text        NOT NULL REFERENCES sending_domains (id) ON DELETE RESTRICT,
    message_category   text,
    priority           integer     NOT NULL DEFAULT 100,
    status             text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (service_id IS NULL OR product_id IS NOT NULL),
    FOREIGN KEY (service_id, product_id) REFERENCES services (id, product_id) ON DELETE CASCADE
);

CREATE TABLE routing_targets
(
    id                    text PRIMARY KEY,
    policy_id             text        NOT NULL REFERENCES routing_policies (id) ON DELETE CASCADE,
    provider_account_id   text        NOT NULL REFERENCES provider_accounts (id) ON DELETE CASCADE,
    provider_identity_id  text        NOT NULL REFERENCES provider_identities (id) ON DELETE RESTRICT,
    priority              integer     NOT NULL DEFAULT 100,
    weight                integer     NOT NULL DEFAULT 100 CHECK (weight > 0),
    rate_limit_per_minute integer     NOT NULL DEFAULT 1000 CHECK (rate_limit_per_minute > 0),
    status                text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'circuit_open')),
    circuit_open_until    timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (provider_identity_id, provider_account_id) REFERENCES provider_identities (id, provider_account_id) ON DELETE RESTRICT,
    UNIQUE (policy_id, provider_identity_id)
);

CREATE TABLE messages
(
    content_purged_at timestamptz,
    id                text PRIMARY KEY,
    product_id        text        NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    service_id        text        NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
    sending_domain_id text NOT NULL REFERENCES sending_domains(id) ON DELETE RESTRICT,
    request_id text,
    to_recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
    cc_recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
    bcc_recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
    headers jsonb NOT NULL DEFAULT '{}'::jsonb,
    in_reply_to text,
    references_ids text[] NOT NULL DEFAULT '{}',
    attachment_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
    sender_snapshot   jsonb       NOT NULL,
    content_policy text NOT NULL DEFAULT 'normal' CHECK(content_policy IN ('normal','sensitive')),
    send_before timestamptz,
    sensitive_content jsonb,
    sensitive_content_purged_at timestamptz,
    idempotency_key   text        NOT NULL,
    payload_hash      text        NOT NULL,
    payload_hash_key_version text,
    reference_id      text,
    metadata          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    recipient_count   integer     NOT NULL CHECK (recipient_count > 0),
    subject           text        NOT NULL,
    html_body         text,
    text_body         text,
    message_category  text        NOT NULL,
    reply_to          jsonb NOT NULL DEFAULT '[]'::jsonb,
    provider_tags     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    accepted_at       timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CHECK (content_policy='sensitive' OR html_body IS NOT NULL OR text_body IS NOT NULL),
    CHECK (content_policy<>'sensitive' OR content_purged_at IS NOT NULL OR (send_before IS NOT NULL AND html_body IS NULL AND text_body IS NULL
      AND subject='[Sensitive content]' AND metadata='{}'::jsonb AND headers='{}'::jsonb AND provider_tags='{}'::jsonb)),
    CHECK (content_policy='sensitive' OR sensitive_content IS NULL),
    UNIQUE (service_id, idempotency_key)
);

CREATE INDEX messages_sensitive_expiry_idx ON messages(send_before) WHERE sensitive_content IS NOT NULL;

CREATE TABLE message_retries (
    message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    idempotency_key text NOT NULL,
    payload_hash text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(message_id,idempotency_key)
);

CREATE TABLE deliveries
(
    id                 text PRIMARY KEY,
    message_id         text        NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    recipient_email    text        NOT NULL,
    recipient_name     text,
    recipient_role text NOT NULL CHECK(recipient_role IN ('to','cc','bcc')),
    last_error jsonb,
    lifecycle_status   text        NOT NULL DEFAULT 'queued' CHECK (lifecycle_status IN
                                                                    ('queued', 'submitting', 'accepted', 'deferred',
                                                                     'delivered', 'bounced', 'failed', 'unknown',
                                                                     'canceled')),
    engagement_status  text        NOT NULL DEFAULT 'unopened' CHECK (engagement_status IN ('unopened', 'opened', 'clicked')),
    compliance_status  text        NOT NULL DEFAULT 'clean' CHECK (compliance_status IN
                                                                   ('clean', 'complained', 'unsubscribed',
                                                                    'suppressed')),
    current_attempt_id text,
    current_submission_id text,

    queued_at          timestamptz NOT NULL DEFAULT now(),
    accepted_at        timestamptz,
    delivered_at       timestamptz,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (message_id, recipient_email)
);

CREATE TABLE submissions
(
    id text PRIMARY KEY,
    message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','submitting','accepted','deferred','unknown','failed','canceled')),
    current_attempt_id text,
    defer_count integer NOT NULL DEFAULT 0 CHECK(defer_count>=0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE submission_deliveries
(
    submission_id text NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    delivery_id text NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    PRIMARY KEY(submission_id,delivery_id)
);

ALTER TABLE deliveries ADD CONSTRAINT deliveries_current_submission_fk FOREIGN KEY (current_submission_id) REFERENCES submissions(id) ON DELETE SET NULL;

CREATE TABLE submission_attempts
(
    id text PRIMARY KEY,
    submission_id text NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    attempt_number integer NOT NULL CHECK(attempt_number>0),
    provider_account_id text NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
    provider_identity_id text NOT NULL REFERENCES provider_identities(id) ON DELETE RESTRICT,
    routing_snapshot jsonb NOT NULL,
    request_fingerprint text NOT NULL,
    provider_idempotency_key text,
    external_message_id text,
    rfc_message_id text,
    status text NOT NULL CHECK(status IN ('submitting','accepted','failed','unknown','reconciling','reconciled')),
    outcome_determinate boolean NOT NULL DEFAULT false,
    error_category text,
    error_code text,
    error_message text,
    diagnostic jsonb,
    provider_response_ref text,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    submission_deadline_at timestamptz NOT NULL DEFAULT now()+interval '2 minutes',
    retry_authorized_at timestamptz,
    retry_authorized_by text,
    reconciliation_count integer NOT NULL DEFAULT 0 CHECK(reconciliation_count>=0),
    reconcile_after timestamptz,
    UNIQUE(submission_id,attempt_number),
    UNIQUE(provider_account_id,external_message_id)
);
ALTER TABLE deliveries ADD CONSTRAINT deliveries_current_attempt_fk FOREIGN KEY(current_attempt_id) REFERENCES submission_attempts(id) ON DELETE SET NULL;
ALTER TABLE submissions ADD CONSTRAINT submissions_current_attempt_fk FOREIGN KEY(current_attempt_id) REFERENCES submission_attempts(id) ON DELETE SET NULL;

CREATE TABLE submission_events
(
    id text PRIMARY KEY,
    submission_id text NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    raw_provider_event_id text,
    attempt_id text REFERENCES submission_attempts(id) ON DELETE SET NULL,
    event_type text NOT NULL,
    source_key text NOT NULL UNIQUE,
    occurred_at timestamptz NOT NULL,
    canonical_payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE raw_provider_events
(
    content_purged_at timestamptz,
    id                  text PRIMARY KEY,
    provider_account_id text        NOT NULL REFERENCES provider_accounts (id) ON DELETE RESTRICT,
    webhook_endpoint_id text        NOT NULL REFERENCES provider_webhook_endpoints (id) ON DELETE RESTRICT,
    provider_event_id   text,
    native_type         text        NOT NULL,
    signature_valid     boolean     NOT NULL,
    replay_valid        boolean     NOT NULL,
    payload_expires_at timestamptz,
    raw_payload_purged_at timestamptz,
    normalized_events jsonb,
    raw_body            bytea,
    raw_object_key      text,
    headers             jsonb       NOT NULL,
    received_at         timestamptz NOT NULL DEFAULT now(),
    processed_at        timestamptz,
    terminated_at       timestamptz,
    processing_error    text,
    verification        jsonb,
    security_version    integer NOT NULL DEFAULT 0,
    processing_attempt_count integer NOT NULL DEFAULT 0 CHECK (processing_attempt_count >= 0),
    next_attempt_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider_account_id, provider_event_id)
);

ALTER TABLE submission_events ADD CONSTRAINT submission_events_raw_event_fk
    FOREIGN KEY(raw_provider_event_id) REFERENCES raw_provider_events(id) ON DELETE SET NULL;
CREATE INDEX submission_events_raw_event_idx ON submission_events(raw_provider_event_id) WHERE raw_provider_event_id IS NOT NULL;

CREATE TABLE delivery_events
(
    id                    text PRIMARY KEY,
    delivery_id           text        NOT NULL REFERENCES deliveries (id) ON DELETE CASCADE,
    raw_provider_event_id text        REFERENCES raw_provider_events (id) ON DELETE SET NULL,
    event_type            text        NOT NULL,
    source_key            text        NOT NULL UNIQUE,
    occurred_at           timestamptz NOT NULL,
    canonical_payload     jsonb       NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE suppressions
(
    id               text PRIMARY KEY,
    scope_type       text        NOT NULL CHECK (scope_type IN ('global', 'product', 'list')),
    product_id       text REFERENCES products (id) ON DELETE CASCADE,
    list_id          text,
    email_normalized text        NOT NULL,
    reason           text        NOT NULL,
    source           text        NOT NULL,
    bounce_count     integer     NOT NULL DEFAULT 0,
    active           boolean     NOT NULL DEFAULT true,
    expires_at       timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CHECK ((scope_type = 'global' AND product_id IS NULL AND list_id IS NULL)
        OR (scope_type = 'product' AND product_id IS NOT NULL AND list_id IS NULL)
        OR (scope_type = 'list' AND product_id IS NOT NULL AND list_id IS NOT NULL)),
    CHECK (email_normalized = lower(email_normalized))
);
CREATE UNIQUE INDEX suppressions_active_scope ON suppressions (scope_type, COALESCE(product_id, '*'), COALESCE(list_id, '*'), email_normalized) WHERE active = true;

CREATE TABLE callback_endpoints
(
    id                text PRIMARY KEY,
    service_id        text        NOT NULL REFERENCES services (id) ON DELETE CASCADE,
    name              text        NOT NULL,
    url               text        NOT NULL,
    secret_ciphertext text        NOT NULL,
    encrypted_dek     text        NOT NULL,
    key_version       text        NOT NULL,
    subscribed_events text[] NOT NULL,
    status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX callback_one_per_service ON callback_endpoints(service_id);

CREATE TABLE inbound_routes
(
    id                           text PRIMARY KEY,
    provider_webhook_endpoint_id text        NOT NULL REFERENCES provider_webhook_endpoints (id) ON DELETE CASCADE,
    sending_domain_id            text        NOT NULL REFERENCES sending_domains (id) ON DELETE CASCADE,
    product_id                   text        NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    service_id                   text        NOT NULL REFERENCES services (id) ON DELETE CASCADE,
    status                       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at                   timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (service_id, product_id) REFERENCES services (id, product_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX inbound_route_scope ON inbound_routes(provider_webhook_endpoint_id,sending_domain_id,service_id);

CREATE TABLE inbound_messages
(
    content_purged_at timestamptz,
    id                    text PRIMARY KEY,
    inbound_route_id      text        REFERENCES inbound_routes (id) ON DELETE SET NULL,
    product_id            text        REFERENCES products (id) ON DELETE SET NULL,
    service_id            text        REFERENCES services (id) ON DELETE SET NULL,
    provider_account_id   text        NOT NULL REFERENCES provider_accounts (id) ON DELETE RESTRICT,
    raw_provider_event_id text        REFERENCES raw_provider_events (id) ON DELETE SET NULL,
    external_message_id   text,
    message_id            text,
    delivery_scope        text NOT NULL DEFAULT 'quarantine',
    envelope_recipients   text[] NOT NULL DEFAULT '{}',
    reply_to              text[] NOT NULL DEFAULT '{}',
    in_reply_to           text,
    references_ids        text[] NOT NULL DEFAULT '{}',
    from_email            text        NOT NULL,
    to_emails             text[] NOT NULL,
    cc_emails             text[] NOT NULL DEFAULT '{}',
    bcc_emails            text[] NOT NULL DEFAULT '{}',
    subject               text        NOT NULL,
    sanitized_html        text,
    text_body             text,
    raw_mime_object_key   text,
    status                text        NOT NULL DEFAULT 'scanning' CHECK (status IN ('scanning', 'ready', 'rejected')),
    rejection_reason      text,
    processing_token      text,
    processing_deadline_at timestamptz,
    author_date           timestamptz,
    ingress_received_at   timestamptz,
    ready_at              timestamptz,
    received_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider_account_id, external_message_id, delivery_scope)
);

CREATE TABLE inbound_attachments
(
    content_purged_at timestamptz,
    id                 text PRIMARY KEY,
    inbound_message_id text        NOT NULL REFERENCES inbound_messages (id) ON DELETE CASCADE,
    file_name          text        NOT NULL,
    content_type       text        NOT NULL,
    size_bytes         bigint      NOT NULL,
    object_key         text        NOT NULL,
    content_id         text,
    sha256             text        NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE callback_deliveries
(
    payload_purged_at timestamptz,
    id                 text PRIMARY KEY,
    endpoint_id        text        NOT NULL REFERENCES callback_endpoints (id) ON DELETE CASCADE,
    delivery_event_id  text        REFERENCES delivery_events (id) ON DELETE SET NULL,
    submission_event_id text REFERENCES submission_events(id) ON DELETE SET NULL,
    inbound_message_id text        REFERENCES inbound_messages (id) ON DELETE SET NULL,
    event_type         text        NOT NULL,
    payload            jsonb       NOT NULL,
    status             text        NOT NULL DEFAULT 'pending' CHECK (status IN
                                                                     ('pending', 'delivering', 'delivered', 'retrying',
                                                                      'dead_letter', 'terminated')),
    attempt_count      integer     NOT NULL DEFAULT 0,
    response_code      integer,
    last_error         text,
    next_attempt_at    timestamptz NOT NULL DEFAULT now(),
    delivered_at       timestamptz,
    terminated_at      timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events
(
    id             text PRIMARY KEY,
    aggregate_type text        NOT NULL,
    aggregate_id   text        NOT NULL,
    event_type     text        NOT NULL,
    payload        jsonb       NOT NULL,
    status         text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'failed')),
    attempt_count  integer     NOT NULL DEFAULT 0,
    available_at   timestamptz NOT NULL DEFAULT now(),
    published_at   timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs
(
    id            bigserial PRIMARY KEY,
    actor         text        NOT NULL,
    action        text        NOT NULL,
    resource_type text        NOT NULL,
    resource_id   text,
    details       jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE request_logs
(
    id          bigserial PRIMARY KEY,
    request_id  text NOT NULL UNIQUE,
    service_id text REFERENCES services(id) ON DELETE SET NULL,
    message_id text REFERENCES messages(id) ON DELETE SET NULL,
    method      text        NOT NULL,
    path        text        NOT NULL,
    status_code integer     NOT NULL,
    duration_ms integer     NOT NULL,
    actor       text,
    details     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_service_accepted_cursor ON messages (service_id, accepted_at DESC, id DESC);
CREATE INDEX deliveries_lifecycle_idx ON deliveries (lifecycle_status, queued_at DESC);
CREATE INDEX deliveries_message_status ON deliveries (message_id, lifecycle_status);
CREATE INDEX attempts_external_idx ON submission_attempts (provider_account_id, external_message_id);
CREATE INDEX raw_provider_events_pending_idx ON raw_provider_events (processed_at, received_at);
CREATE INDEX delivery_events_timeline_idx ON delivery_events (delivery_id, occurred_at DESC);
CREATE INDEX callback_deliveries_pending_idx ON callback_deliveries (status, next_attempt_at);
CREATE INDEX outbox_pending_idx ON outbox_events (status, available_at, created_at);
CREATE INDEX inbound_messages_received_idx ON inbound_messages (received_at DESC);
CREATE INDEX inbound_messages_service_received_cursor ON inbound_messages (service_id, received_at DESC, id DESC);
CREATE INDEX delivery_events_delivery_occurred_cursor ON delivery_events (delivery_id, occurred_at DESC, id DESC);
CREATE INDEX request_logs_created_idx ON request_logs (created_at DESC);
CREATE INDEX request_logs_service ON request_logs(service_id,created_at DESC);
CREATE INDEX submission_deliveries_delivery ON submission_deliveries(delivery_id);
CREATE INDEX submissions_message ON submissions(message_id);
CREATE INDEX submission_events_timeline ON submission_events(submission_id,occurred_at DESC,id DESC);
CREATE UNIQUE INDEX callback_submission_event_once ON callback_deliveries(endpoint_id,submission_event_id) WHERE submission_event_id IS NOT NULL;


CREATE UNIQUE INDEX callback_delivery_event_once ON callback_deliveries(endpoint_id, delivery_event_id) WHERE delivery_event_id IS NOT NULL;
CREATE UNIQUE INDEX callback_inbound_event_once ON callback_deliveries(endpoint_id, inbound_message_id, event_type) WHERE inbound_message_id IS NOT NULL;
CREATE INDEX submissions_recovery ON submissions(status,updated_at) WHERE status IN ('queued','deferred','submitting','unknown');
CREATE INDEX attempts_reconcile_due ON submission_attempts(reconcile_after) WHERE status IN ('unknown','reconciling');
CREATE INDEX raw_events_retry_due ON raw_provider_events(next_attempt_at) WHERE processed_at IS NULL;
CREATE INDEX inbound_scan_due ON inbound_messages(processing_deadline_at) WHERE status='scanning';
CREATE INDEX provider_attempt_usage ON submission_attempts(provider_account_id, started_at);

CREATE TABLE rate_limit_counters (
    scope text NOT NULL,
    key text NOT NULL,
    window_start timestamptz NOT NULL,
    count bigint NOT NULL CHECK(count >= 0),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY(scope, key, window_start)
);
CREATE INDEX rate_limit_expiry ON rate_limit_counters(expires_at);

CREATE TABLE worker_heartbeats (
    worker_id text PRIMARY KEY,
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX worker_heartbeat_recency ON worker_heartbeats(last_seen_at);

-- Upload intents make object-store/database handoff failures reclaimable.
CREATE TABLE pending_object_deletions (
    object_key text PRIMARY KEY,
    available_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
    created_at timestamptz NOT NULL DEFAULT now(),
    last_error text,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)
);
CREATE INDEX pending_object_deletions_due ON pending_object_deletions(available_at);

-- Frozen receipt decisions contain routing metadata only, never mail content.
CREATE TABLE inbound_receipts (
  provider_account_id text NOT NULL REFERENCES provider_accounts(id),
  external_message_id text NOT NULL,
  routes jsonb NOT NULL,
  terminated_at timestamptz,
  ingress_received_at timestamptz NOT NULL,
  PRIMARY KEY(provider_account_id,external_message_id)
);

-- A transactional counter row serializes writers through COMMIT, unlike a sequence.
CREATE TABLE inbound_streams (
  service_id text PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  position bigint NOT NULL DEFAULT 0,
  floor bigint NOT NULL DEFAULT 0
);
CREATE TABLE inbound_changes (
  service_id text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  position bigint NOT NULL,
  id text NOT NULL UNIQUE DEFAULT ('ich_' || gen_random_uuid()::text),
  inbound_message_id text NOT NULL REFERENCES inbound_messages(id) ON DELETE CASCADE,
  type text NOT NULL CHECK(type IN ('inbound.available','inbound.content_purged')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(service_id,position)
);
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
CREATE INDEX inbound_evidence ON inbound_messages(service_id,provider_account_id,created_at DESC) WHERE status='ready';
CREATE INDEX submission_events_evidence ON submission_events(submission_id,event_type,occurred_at DESC);

CREATE INDEX inbound_messages_service_stored_cursor ON inbound_messages(service_id,created_at DESC,id DESC);

-- Attachment safety jobs are byte-bound private facts, never cross-service deduplication.
CREATE TABLE attachment_scan_scopes (
  scope text PRIMARY KEY,
  last_dispatched_at timestamptz NOT NULL DEFAULT '-infinity'
);
CREATE TABLE attachment_safety (
  resource_id text PRIMARY KEY,
  kind text NOT NULL CHECK(kind IN ('outbound','inbound')),
  service_id text REFERENCES services(id) ON DELETE CASCADE,
  scope text NOT NULL REFERENCES attachment_scan_scopes(scope),
  expected_sha256 text NOT NULL,
  scanned_sha256 text,
  policy_version text,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','scanning','clean','malicious','unavailable','blocked','purged')),
  reason text,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  queued_until timestamptz,
  outbox_id text,
  lease_token text,
  lease_expires_at timestamptz,
  checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachment_safety_due ON attachment_safety(scope,next_attempt_at,resource_id) WHERE status NOT IN ('malicious','blocked','purged');
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
