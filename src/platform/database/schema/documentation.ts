import { getTableColumns, getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import * as schema from "./index";

type SchemaDocumentation = {
  [Table in keyof typeof schema]: {
    table: string;
    columns: { [Column in keyof (typeof schema)[Table]["_"]["columns"]]: string };
  };
};

// Shared wording describes the database clock, not an application-side automatic update mechanism.
const created = "Record creation time (timestamptz); defaults to the database transaction start time, now()";
const updated = "Last update time (timestamptz); explicitly maintained by business writes, defaults to now()";
const purged = "Irreversible content purge time (timestamptz); a non-null value prevents content reads while retaining business metadata";

/** Every entry is deliberately authored; adding a table/column requires an explicit business description. */
export const schemaDocumentation = {
  services: { table: "Calling services; isolation boundary for API credentials, messages and send/receive permissions", columns: {
    id: "Unique service identifier", name: "Globally unique service name, compared case-insensitively", status: "Service status: active (available) or suspended (paused)",
    suppressionManagementAllowed: "Whether the service API may manage its own suppression rules; denied by default",
    configurationRevision: "Positive configuration revision used for optimistic concurrency checks", createdAt: created, updatedAt: updated,
  } },
  serviceCredentials: { table: "Service API credentials storing only a key digest and display prefix, never the original API key", columns: {
    id: "Unique API credential identifier", serviceId: "Service that owns this credential", keyPrefix: "Display prefix for identifying the credential; insufficient for authentication",
    keyHash: "Globally unique, irreversible API key digest used to verify the original key", status: "Credential status: active (valid) or revoked",
    validFrom: "Credential validity start time (timestamptz)", validTo: "Credential validity end time (timestamptz); null means no configured expiration",
    lastUsedAt: "Last successful use of this credential (timestamptz)", createdAt: created,
  } },
  serviceDomainBindings: { table: "Service and domain associations; receiving can fan out to multiple services and each service chooses its own outbound identity", columns: {
    id: "Unique service-domain binding identifier", serviceId: "Service bound to the domain", sendingDomainId: "Bound email domain",
    receiveEnabled: "Whether this service receives a private copy of inbound mail for the domain",
    outboundProviderIdentityId: "Provider sending identity for this service and domain; null disables sending",
    createdAt: created, updatedAt: updated,
  } },
  providerAccounts: { table: "Email provider accounts and non-secret configuration; authentication secrets are encrypted in a separate credentials table", columns: {
    id: "Unique provider account identifier", type: "Provider type: resend, ses, sendgrid, mailgun, postmark or mock", name: "Globally unique provider account name",
    status: "Account status: active (available), disabled or degraded (configuration or health issue)",
    publicConfig: "Non-secret provider configuration JSON; type-specific regions, configuration sets and message streams; must not contain authentication secrets",
    configSchemaVersion: "Configuration schema version used to parse public_config",
    health: "Provider health check JSON including capabilities and identity diagnostics; initial status is unknown",
    quota: "Provider quota snapshot JSON containing limits and usage; an empty object means no snapshot is available", createdAt: created, updatedAt: updated,
  } },
  providerCredentials: { table: "Versioned, envelope-encrypted provider authentication credentials; at most one active version per account", columns: {
    id: "Unique provider credential identifier", providerAccountId: "Provider account that owns this credential", credentialVersion: "Positive credential version, unique within the provider account",
    secretCiphertext: "Encrypted provider authentication configuration; plaintext API keys, tokens and access keys must never be stored here",
    encryptedDek: "Data encryption key (DEK) encrypted with the master key; required to decrypt secret_ciphertext",
    keyVersion: "Version of the master key wrapping the DEK, used for key rotation", status: "Credential status: active (currently valid) or revoked",
    validFrom: "Credential validity start time (timestamptz)", validTo: "Credential validity end time (timestamptz); null means no configured expiration", createdAt: created,
    createdBy: "Actor that created this credential, for tracing secret changes",
  } },
  providerWebhookEndpoints: { table: "Provider inbound webhook endpoints and encrypted verification configuration; at most one endpoint per provider account", columns: {
    id: "Unique provider webhook endpoint identifier", providerAccountId: "Provider account that owns this endpoint", opaqueToken: "Unguessable webhook URL routing token; does not replace provider signature verification",
    securityConfigCiphertext: "Encrypted webhook signature verification or authentication configuration; null when unconfigured", securityEncryptedDek: "Encrypted DEK paired with the webhook security configuration ciphertext",
    keyVersion: "Master key version wrapping the webhook security DEK; null when unconfigured", securityVersion: "Verification configuration revision, captured when receiving events",
    securityConfigured: "Whether webhook security configuration is complete", status: "Endpoint status: active (receiving) or disabled",
    expectedTopicArn: "Allowed SES SNS topic ARN used to restrict notification sources", ipAllowlist: "Allowed source IP addresses or CIDR ranges for providers requiring source address checks",
    createdAt: created, updatedAt: updated,
  } },
  sendingDomains: { table: "Managed email domains shared by service bindings; inbound mail routes by recipient domain", columns: {
    id: "Unique email domain identifier", domain: "Globally unique normalized email domain",
    status: "Domain status: active (available) or disabled", createdAt: created, updatedAt: updated,
  } },
  providerIdentities: { table: "Domain sending identities within provider accounts and their DNS verification status", columns: {
    id: "Unique provider sending identity identifier", sendingDomainId: "Managed email domain represented by this identity", providerAccountId: "Provider account that owns this identity",
    externalIdentityId: "Provider-side identity identifier; may be null before a remote identity is created", status: "Identity status: pending (awaiting verification), verified, failed or disabled",
    dnsRecords: "JSON array of required DNS records, including names, types, values and verification details; empty when unavailable",
    lastCheckedAt: "Last provider identity verification check (timestamptz)", createdAt: created, updatedAt: updated,
  } },
  messages: { table: "Outbound message requests and immutable sending snapshots; deduplicated by service and idempotency key, with sensitive content envelope-encrypted", columns: {
    contentPurgedAt: purged, id: "Unique outbound message identifier", serviceId: "Service that submitted this message",
    sendingDomainId: "Sending domain used by this message", requestId: "Optional trace identifier of the API request accepting this message",
    toRecipients: "JSON array of primary recipients with email and optional name; sensitive messages retain only addresses in plaintext",
    ccRecipients: "JSON array of carbon-copy recipients with email and optional name; sensitive messages retain only addresses in plaintext",
    bccRecipients: "JSON array of blind-copy recipients, restricted to authorized internal flows; sensitive messages retain only addresses in plaintext",
    headers: "Custom email header JSON object; must be empty in the plaintext fields of sensitive messages", inReplyTo: "RFC Message-ID of the message being replied to; null in sensitive message plaintext",
    referencesIds: "Ordered array of conversation RFC Message-IDs; empty in sensitive message plaintext",
    attachmentSnapshot: "Attachment metadata JSON array captured for sending, including file IDs, names, types, byte sizes, digests and object keys; sensitive filenames are redacted",
    senderSnapshot: "Sender identity JSON snapshot, including fromEmail and fromName; sensitive display names are redacted",
    contentPolicy: "Content policy: normal or sensitive (encrypted with a deadline); sensitive messages require send_before",
    sendBefore: "Absolute sending submission deadline (timestamptz); forbids decryption and new submissions after expiry; required for sensitive messages",
    sensitiveContent: "Envelope-encrypted JSON containing sensitive bodies, subject, display names, headers and metadata; must be null for normal messages",
    sensitiveContentPurgedAt: "Sensitive ciphertext purge time (timestamptz); sending content cannot be recovered afterward",
    idempotencyKey: "Caller-supplied message idempotency key, unique within the service", payloadHash: "Canonical request digest: SHA-256 for normal messages, keyed digest for sensitive messages",
    payloadHashKeyVersion: "Master key version used for the sensitive request digest; may be null for normal messages", referenceId: "Caller business reference for lookup; does not provide idempotency",
    metadata: "Caller business metadata JSON object; must be empty in sensitive message plaintext", recipientCount: "Total primary, carbon-copy and blind-copy recipients; must be positive",
    subject: "Email subject; fixed to [Sensitive content] in sensitive message plaintext and may be cleared after content purge", htmlBody: "Normal message HTML body; must be null in sensitive message plaintext",
    textBody: "Normal message plain-text body; must be null in sensitive message plaintext", messageCategory: "Optional business message classification retained for reporting",
    replyTo: "JSON array of reply addresses with email and optional name; empty in sensitive message plaintext", providerTags: "Provider tag JSON object; must be empty in sensitive message plaintext",
    acceptedAt: "System message acceptance time (timestamptz, defaults to database transaction time); distinct from provider acceptance", updatedAt: updated,
  } },
  deliveries: { table: "Per-recipient outbound delivery state, with independent lifecycle, engagement and compliance statuses", columns: {
    id: "Unique recipient delivery identifier", messageId: "Owning outbound message identifier", recipientEmail: "Recipient email address, unique within the message",
    recipientName: "Optional recipient display name", recipientRole: "Recipient role: to (primary), cc (carbon copy) or bcc (blind copy)",
    lastError: "Latest delivery error JSON containing code, category and description; may be null after success or when no error exists",
    lifecycleStatus: "Delivery lifecycle: queued, submitting, accepted, deferred, delivered, bounced, failed, unknown (indeterminate outcome) or canceled",
    engagementStatus: "Engagement status: unopened, opened or clicked", complianceStatus: "Compliance status: clean (unrestricted), complained, unsubscribed or suppressed",
    currentAttemptId: "Current provider submission attempt; null when absent or deleted", currentSubmissionId: "Current sending submission; null when absent or deleted",
    queuedAt: "Time this recipient delivery entered the system queue (timestamptz)", acceptedAt: "Provider event time confirming acceptance for this recipient (timestamptz)",
    deliveredAt: "Provider event time reporting final delivery (timestamptz)", updatedAt: updated,
  } },
  submissions: { table: "Outbound sending units grouping recipients and traceable provider submission attempts", columns: {
    id: "Unique sending submission identifier", messageId: "Owning outbound message identifier", status: "Submission status: queued, submitting, accepted, deferred, unknown (indeterminate outcome), failed or canceled",
    currentAttemptId: "Current provider submission attempt; set to null if that attempt is deleted", deferCount: "Non-negative cumulative number of submission deferrals", createdAt: created, updatedAt: updated,
  } },
  submissionAttempts: { table: "Individual provider sending attempts and evidence, retaining routing decisions, idempotency, outcome certainty and reconciliation details", columns: {
    id: "Unique provider submission attempt identifier", submissionId: "Owning sending submission identifier", attemptNumber: "Attempt sequence starting at one, unique within the submission",
    providerAccountId: "Provider account actually used for this attempt", providerIdentityId: "Provider sending identity actually used for this attempt",
    routingSnapshot: "Routing decision JSON snapshot with matched policy, selected target, candidates, exclusions, selection time and recipient count",
    requestFingerprint: "Provider request digest: SHA-256 for normal content or a keyed digest for sensitive content; avoids retaining the plaintext request",
    providerIdempotencyKey: "Request key sent to providers supporting native idempotency; null when unsupported", externalMessageId: "Provider-returned message identifier, unique within the provider account",
    rfcMessageId: "RFC Message-ID used in the request or confirmed by the provider, for conversation and evidence correlation",
    status: "Attempt status: submitting, accepted, failed (definite failure), unknown (indeterminate outcome), reconciling or reconciled",
    outcomeDeterminate: "Whether explicit evidence confirms the provider acceptance outcome; indeterminate outcomes must not trigger blind resends",
    errorCategory: "Normalized provider error category; null when no error exists", errorCode: "Normalized or provider-specific error code; null when no error exists", errorMessage: "Redacted error description; must not contain authentication secrets or sensitive message bodies",
    diagnostic: "Redacted provider diagnostic JSON for protocol, network or response failures", providerResponseRef: "Reference to provider response evidence; does not store secret response content directly",
    startedAt: "Attempt start time (timestamptz, defaults to database transaction time)", finishedAt: "Attempt completion or outcome confirmation time (timestamptz)",
    submissionDeadlineAt: "Deadline for the submission result (timestamptz); defaults to two minutes after transaction start, used for recovery and reconciliation",
    retryAuthorizedAt: "Manual or business retry authorization time (timestamptz); null means not authorized", retryAuthorizedBy: "Actor that authorized the retry",
    reconciliationCount: "Non-negative number of completed reconciliation attempts", reconcileAfter: "Earliest next reconciliation time (timestamptz); null when unscheduled",
  } },
  deliveryEvents: { table: "Canonical per-recipient delivery facts; source_key prevents duplicate recording of repeated notifications", columns: {
    id: "Unique delivery event identifier", deliveryId: "Recipient delivery associated with this event", rawProviderEventId: "Source raw provider event; null for internal events or after source deletion",
    eventType: "Canonical delivery event type driving lifecycle, engagement or compliance state", sourceKey: "Globally unique event source deduplication key",
    occurredAt: "Actual event time from the provider or internal action (timestamptz)", canonicalPayload: "Canonical event JSON containing type, time, reason and associated metadata", createdAt: created,
  } },
  submissionEvents: { table: "Canonical sending submission evidence used for acceptance confirmation, recovery and reconciliation", columns: {
    id: "Unique submission event identifier", submissionId: "Sending submission associated with this event", rawProviderEventId: "Source raw provider event; null for internal events or after source deletion",
    attemptId: "Optional provider submission attempt associated with the event", eventType: "Canonical submission event type describing submission, acceptance, failure or reconciliation facts",
    sourceKey: "Globally unique submission event source deduplication key", occurredAt: "Actual event time (timestamptz), distinct from database insertion time",
    canonicalPayload: "Canonical submission event JSON retaining event content and evidence metadata", createdAt: created,
  } },
  rawProviderEvents: { table: "Provider webhook receipt evidence and asynchronous processing work; raw payloads, verification evidence and normalized facts follow retention policies", columns: {
    contentPurgedAt: purged, id: "Unique raw provider event identifier", providerAccountId: "Provider account receiving this event", webhookEndpointId: "Provider webhook endpoint that received this event",
    providerEventId: "Native provider event identifier; deduplicated with the provider account when present", nativeType: "Native provider event type name",
    signatureValid: "Whether the signature or equivalent source authentication was valid at receipt", replayValid: "Whether timestamp, token or equivalent replay checks passed at receipt",
    payloadExpiresAt: "Retention deadline for raw payload and verification evidence (timestamptz)", rawPayloadPurgedAt: "Raw payload purge time (timestamptz); does not imply all business metadata has been purged",
    normalizedEvents: "JSON array of normalized provider events for asynchronous processing; may contain business content subject to retention",
    rawBody: "Original HTTP request body bytes for signature verification and reprocessing; may be replaced by an object reference or purged by policy",
    rawObjectKey: "Private object storage key for the original request body; contains no public access credentials", headers: "Received HTTP headers as JSON; sensitive information follows security and retention policies",
    receivedAt: "System webhook receipt time (timestamptz, defaults to database transaction time)", processedAt: "Successful asynchronous event processing completion time (timestamptz)",
    terminatedAt: "Manual or system processing termination time (timestamptz); non-null stops automatic retries", processingError: "Latest redacted processing failure description",
    verification: "Envelope-encrypted verification evidence JSON bound to the raw event identifier; plaintext authentication secrets are forbidden", securityVersion: "Webhook security configuration version captured when receiving the event",
    processingAttemptCount: "Non-negative asynchronous processing attempt count", nextAttemptAt: "Earliest next asynchronous processing time (timestamptz)",
  } },
  submissionDeliveries: { table: "Association between sending submissions and recipient deliveries; one submission may contain multiple recipients", columns: {
    submissionId: "Sending submission identifier; part of the composite primary key with delivery_id", deliveryId: "Recipient delivery identifier; part of the composite primary key with submission_id",
  } },
  messageRetries: { table: "Idempotency records for message retry operations; repeated message/key pairs reuse the original result", columns: {
    messageId: "Outbound message being retried", idempotencyKey: "Caller retry operation key, unique within the message", payloadHash: "Retry request digest detecting different requests reusing the same idempotency key",
    result: "Initial retry operation result JSON returned unchanged for repeated requests", createdAt: created,
  } },
  inboundMessages: { table: "Inbound messages and service-isolated copies; quarantined mail has no service owner and business reads require completed scanning", columns: {
    contentPurgedAt: purged, id: "Unique inbound message identifier",
    serviceId: "Owning service; null for quarantined mail or after service deletion", providerAccountId: "Provider account receiving the message", rawProviderEventId: "Source raw webhook event; null after source event deletion",
    externalMessageId: "Provider inbound message identifier, deduplicated with account and delivery scope", messageId: "RFC Message-ID from email headers; not an outbound messages primary key",
    deliveryScope: "Ownership scope key for isolated copies; quarantine for unassigned mail, service-specific for routed copies; used for provider message deduplication",
    envelopeRecipients: "Provider-authenticated SMTP envelope recipient array used for routing and authorization; untrusted email headers must not replace it",
    replyTo: "Reply-To email header address array", inReplyTo: "RFC Message-ID from the In-Reply-To header", referencesIds: "Ordered RFC Message-ID array from the References header",
    fromEmail: "Sender email header content; does not establish authenticated identity", toEmails: "Primary recipient email header array; not trusted for envelope routing",
    ccEmails: "Carbon-copy email header address array", bccEmails: "Provider-supplied blind-copy address array, possibly empty and isolated by service permissions",
    subject: "Inbound email subject, subject to content retention policy", sanitizedHtml: "Sanitized HTML body; unsanitized provider content must not be served directly", textBody: "Inbound email plain-text body",
    rawMimeObjectKey: "Optional private object storage key for the original MIME message", status: "Processing status: scanning (processing or awaiting scan), ready (content available) or rejected",
    rejectionReason: "Reason code or description for rejection or unavailable content", processingToken: "Random processing lease token preventing stale workers from overwriting newer results",
    processingDeadlineAt: "Current inbound processing lease deadline (timestamptz); recovery may reclaim expired work",
    authorDate: "Author-declared Date header value (timestamptz); untrusted and not used for system receipt ordering",
    ingressReceivedAt: "Initial webhook ingress receipt time (timestamptz); preserved across retries",
    readyAt: "Time the message first completed processing and became available (timestamptz)", receivedAt: "Inbound record receipt clock (timestamptz, defaults to wall-clock clock_timestamp()), distinct from transaction start time",
    createdAt: created,
  } },
  inboundStreams: { table: "Per-service inbound change stream cursors; row locks keep positions monotonically ordered within each service", columns: {
    serviceId: "Owning service identifier, with one stream per service", generation: "Stream generation UUID identifying rebuilds and invalidating earlier cursors",
    position: "Latest allocated per-service change position; bigint starting at zero, not a time value", floor: "Purged change position lower bound; bigint, with older cursors requiring resynchronization",
  } },
  inboundReceipts: { table: "Idempotent receipts freezing initial provider inbound routing results; retries reuse the first receipt time and ownership snapshot", columns: {
    providerAccountId: "Receiving provider account; composite primary key with external_message_id", externalMessageId: "Provider inbound message identifier, unique within the account",
    routes: "Initial route JSON array containing route id, service_id and matched recipients; retries must not reassign ownership",
    terminatedAt: "Inbound receipt processing termination time (timestamptz); non-null forbids further processing", ingressReceivedAt: "Initial webhook receipt time (timestamptz), reused unchanged on retries",
  } },
  inboundChanges: { table: "Per-service ordered inbound change facts; triggers write atomically with message availability or content purge", columns: {
    serviceId: "Owning service identifier; composite primary key with position", position: "Monotonically increasing per-service bigint position allocated under an inbound_streams row lock; not a timestamp",
    id: "Globally unique inbound change identifier, defaulting to ich_ plus a random UUID", inboundMessageId: "Inbound message affected by the change",
    type: "Change type: inbound.available (message becomes available) or inbound.content_purged (content removed)",
    recordedAt: "Change recording time (timestamptz, defaults to wall-clock clock_timestamp()); stream ordering uses position",
  } },
  outboundFiles: { table: "Service-uploaded outbound attachment metadata; private objects require successful safety scanning and domain authorization before use", columns: {
    id: "Unique outbound attachment identifier", serviceId: "Service that uploaded and owns this file", sendingDomainId: "Bound sending domain, checked against current permissions when used",
    fileName: "Original attachment filename; requires safe encoding in download response headers", contentType: "Declared MIME type; does not establish safety", sizeBytes: "File content size in bytes; must be positive",
    sha256: "Upload-time hexadecimal SHA-256 content digest; the safety scan must match it", objectKey: "Globally unique private object storage key, not a public download URL",
    contentPurgedAt: purged, createdAt: created,
  } },
  inboundAttachments: { table: "Inbound attachment metadata inheriting the owning message service isolation and retention policy", columns: {
    contentPurgedAt: purged, id: "Unique inbound attachment identifier", inboundMessageId: "Owning inbound message identifier; metadata is deleted when the message is deleted",
    fileName: "Provider-supplied attachment filename; requires safe download header encoding", contentType: "Provider-declared attachment MIME type; does not establish scan safety",
    sizeBytes: "Attachment content size in bytes", objectKey: "Private object storage key for the attachment", contentId: "MIME Content-ID for inline attachments; may be null for regular attachments",
    sha256: "Write-time hexadecimal SHA-256 content digest used to verify scanned content consistency", createdAt: created,
  } },
  pendingObjectDeletions: { table: "Object upload compensation and deferred deletion tasks; cleared on business commit, with abandoned objects removed after their deadline", columns: {
    objectKey: "Private object storage key pending compensating cleanup; one task per key", availableAt: "Earliest deletion time (timestamptz); defaults to ten minutes after transaction start to allow business commit",
    createdAt: created, lastError: "Latest redacted object deletion failure description", attemptCount: "Non-negative deletion attempt count",
  } },
  attachmentSafety: { table: "Shared inbound/outbound attachment scan state and leases; content digests and policy versions determine whether scan results can be reused", columns: {
    resourceId: "Globally unique scanned attachment identifier referencing an outbound file or inbound attachment", kind: "Attachment source: outbound (uploaded file) or inbound (received attachment)",
    serviceId: "Owning service; may be null for administrator quarantine attachments", scope: "Fair scan scheduling scope: service identifier, or administrator when unassigned",
    expectedSha256: "Expected SHA-256 content digest registered to detect object replacement", scannedSha256: "Actual scanned content SHA-256 digest; a clean result must match the expected digest",
    policyVersion: "Safety policy version producing the scan result; policy changes require rescanning stale results",
    status: "Scan status: pending, scanning, clean (safe), malicious, unavailable (scanner unavailable), blocked or purged",
    reason: "Scan or block reason code, including content purge, digest mismatch or malicious content", attemptCount: "Non-negative scan attempt count",
    nextAttemptAt: "Earliest next scan retry time (timestamptz)", queuedUntil: "Queued scan reservation deadline (timestamptz) preventing duplicate dispatch",
    outboxId: "Transactional outbox event associated with this scan dispatch", leaseToken: "Random scan execution lease token required when writing results",
    leaseExpiresAt: "Scan execution lease expiry (timestamptz); another worker may reclaim work after expiry", checkedAt: "Latest scan result time (timestamptz)", updatedAt: updated,
  } },
  attachmentScanScopes: { table: "Per-service fair attachment scan scheduling cursors limiting monopolization and rotating due work", columns: {
    scope: "Unique scan scope key: service identifier or administrator", lastDispatchedAt: "Last scope dispatch time (timestamptz, written with clock_timestamp()); initially -infinity to prioritize first dispatch",
  } },
  callbackEndpoints: { table: "Service callback destinations and envelope-encrypted signing secrets; at most one endpoint per service", columns: {
    id: "Unique callback endpoint identifier", serviceId: "Owning service identifier, unique per endpoint", name: "Callback endpoint display name",
    url: "Callback HTTP URL; required and nonempty when active, with SSRF safety checks applied during delivery",
    secretCiphertext: "Encrypted callback signing secret; plaintext signing keys must not be stored here", encryptedDek: "Encrypted DEK for the callback signing secret", keyVersion: "Master key version wrapping the callback DEK",
    subscribedEvents: "Subscribed canonical business event type array; only matching events generate callbacks", status: "Endpoint status: active (enabled) or disabled", createdAt: created, updatedAt: updated,
  } },
  callbackDeliveries: { table: "Reliable business callback delivery tasks with source events, retry schedules and termination state", columns: {
    payloadPurgedAt: "Callback payload purge time (timestamptz); retains task metadata and forbids delivery using purged payloads",
    id: "Unique callback delivery task identifier", endpointId: "Target callback endpoint identifier", deliveryEventId: "Related recipient delivery event; null for other sources or after event deletion",
    submissionEventId: "Related submission event; null for other sources or after event deletion", inboundMessageId: "Related inbound message; null for other sources or after message deletion",
    eventType: "Canonical business event type being reported", payload: "Business event JSON sent to the callback target; subject to retention and must not contain provider secrets",
    status: "Callback status: pending, delivering, delivered, retrying, dead_letter (retries exhausted) or terminated",
    attemptCount: "Number of HTTP delivery attempts executed", responseCode: "Latest target HTTP response status code; null when no response was received", lastError: "Latest redacted callback delivery failure reason",
    nextAttemptAt: "Earliest next retry time (timestamptz)", deliveredAt: "Successful callback delivery time (timestamptz)", terminatedAt: "Termination time stopping further deliveries (timestamptz)",
    createdAt: created, updatedAt: updated,
  } },
  suppressions: { table: "Email sending suppression rules at global, service and service-specific list scopes", columns: {
    id: "Unique suppression rule identifier", scopeType: "Scope type: global, service or list; determines required and forbidden service/list identifiers",
    serviceId: "Owning service; must be null for global scope and present for service/list scopes", listId: "Service-specific business list identifier; required only for list scope and null otherwise",
    emailNormalized: "Lowercase email address enforced by the database, unique within the active scope", reason: "Suppression reason, such as bounce, complaint, unsubscribe or manual action",
    source: "Suppression source identifier tracing provider events or manual actions", bounceCount: "Cumulative bounce count for this rule, used in bounce suppression decisions", active: "Whether the rule is enabled; at most one active rule per email and scope",
    expiresAt: "Rule expiration time (timestamptz); null means no time-based expiration", createdAt: created, updatedAt: updated,
  } },
  outboxEvents: { table: "Transactional outbox writing business state and asynchronous work in one database transaction before reliable queue publication", columns: {
    id: "Unique transactional outbox event identifier", aggregateType: "Business aggregate type owning the event", aggregateId: "Business aggregate identifier owning the event", eventType: "Asynchronous business event type to publish",
    payload: "Queue task JSON containing required business identifiers and parameters; excludes authentication secrets and unnecessary sensitive bodies",
    status: "Publication status: pending, published or failed", attemptCount: "Cumulative queue publication attempt count",
    availableAt: "Earliest publication time (timestamptz), used for delayed work and retry backoff", publishedAt: "Successful queue publication time (timestamptz)", createdAt: created,
  } },
  auditLogs: { table: "Administrative audit facts recording actors, resources and redacted change details", columns: {
    id: "Database-generated bigint audit sequence number, not a business resource identifier", actor: "Actor performing the administrative operation", action: "Administrative operation name or code",
    resourceType: "Business type of the affected resource", resourceId: "Affected resource identifier; null when no specific resource applies", details: "Audit detail JSON containing redacted summaries; plaintext credentials and sensitive bodies are forbidden", createdAt: created,
  } },
  requestLogs: { table: "Service API request traces linking request identifiers to responses, duration and business resources", columns: {
    id: "Database-generated bigint request log sequence number", requestId: "Globally unique API request trace identifier", serviceId: "Authenticated service; null for anonymous requests or after service deletion",
    messageId: "Associated outbound message; null when absent or after message deletion", method: "HTTP request method", path: "HTTP request path; must not include authentication secrets",
    statusCode: "HTTP response status code", durationMs: "Request processing duration in milliseconds", actor: "Request actor identifier; null when unknown",
    details: "Request diagnostic JSON containing only permitted redacted information; Authorization, credentials and sensitive bodies are forbidden", createdAt: created,
  } },
  outboundStreams: { table: "Service-owned committed outbound change prefix and retention boundary", columns: {
    serviceId: "Owning Service and primary key", generation: "Stream identity rejecting cursors from replaced streams", position: "Latest per-Service bigint position allocated under a transaction row lock", floor: "Last removed prefix position; cursors below it require reconciliation",
  } },
  outboundChanges: { table: "Content-free committed outbound event references for incremental reconciliation", columns: {
    serviceId: "Owning Service; composite primary key with position", position: "Per-Service committed stream position independent of provider occurrence time", id: "Canonical delivery or submission event identifier", messageId: "Owning outbound message", type: "Canonical event type", recordedAt: "Local insertion time used for 90-day prefix retention",
  } },
  workerHeartbeats: { table: "Asynchronous worker liveness heartbeats used by health checks to detect recent activity", columns: {
    workerId: "Unique worker instance identifier", lastSeenAt: "Latest heartbeat time (timestamptz); indicates liveness, not process start time",
  } },
  rateLimitCounters: { table: "Atomic database rate limit window counters isolated by scope, business key and window start, with expiry-based cleanup", columns: {
    scope: "Rate limit scope name, such as provider, sending identity or administrative authentication", key: "Limited entity key within the scope; composite primary key with scope and window_start",
    windowStart: "Fixed rate limit window start (timestamptz), bucketed from database time using the configured seconds", count: "Non-negative bigint consumed quota: recipients for sending limits, requests for authentication limits",
    expiresAt: "Counter cleanup eligibility time (timestamptz); retains a short buffer after window end and does not reset the business limit",
  } },
} satisfies SchemaDocumentation;

function identifier(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function literal(value: string) { return `'${value.replaceAll("'", "''")}'`; }

/** Runtime validation also protects generation invoked without TypeScript type-checking. */
export function schemaCommentsSql() {
  const entries = schemaDocumentation as Record<string, { table: string; columns: Record<string, string> }>;
  const statements = ["-- Business data dictionary maintained in schema/documentation.ts; do not add separate comment migrations."];
  const knownTables = new Set(Object.keys(schema));
  for (const key of Object.keys(entries)) if (!knownTables.has(key)) throw new Error(`Unknown documented table: ${key}`);
  for (const [key, table] of Object.entries(schema).sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const documentation = entries[key];
    if (!documentation?.table.trim()) throw new Error(`Missing table description: ${key}`);
    const columns = getTableColumns(table as PgTable);
    const tableName = identifier(getTableName(table));
    statements.push(`COMMENT ON TABLE ${tableName} IS ${literal(documentation.table)};`);
    for (const columnKey of Object.keys(documentation.columns)) {
      if (!(columnKey in columns)) throw new Error(`Unknown documented column: ${key}.${columnKey}`);
    }
    for (const [columnKey, column] of Object.entries(columns)) {
      const description = documentation.columns[columnKey];
      if (!description?.trim()) throw new Error(`Missing column description: ${key}.${columnKey}`);
      statements.push(`COMMENT ON COLUMN ${tableName}.${identifier(column.name)} IS ${literal(description)};`);
    }
  }
  return statements.join("\n") + "\n";
}
