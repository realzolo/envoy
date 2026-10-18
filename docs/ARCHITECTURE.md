# Envoy Architecture

## Trust boundaries

Business services authenticate with service-scoped credentials and know nothing about the active email provider. Their
request and callback contracts contain no provider-specific fields. Provider SDKs and native payloads are confined to
modules under `src/modules/providers`.

Business services own content definitions, localization, and rendering. They submit native sender and recipient fields, the final subject, HTML and/or plain text, optional attachments,
thread references, and a stable message category (default `transactional`). Envoy persists only the resulting delivery payload needed for operations;
it has no business content registry, versioning model, or rendering engine.

The core domain imports only `CanonicalMessage`, `CanonicalEvent`, and `CanonicalProviderError`. A provider module
exposes a descriptor, capabilities, and narrow ports for sending, webhook processing, identity management, inbound mail,
suppression synchronization, reconciliation, and health checks.

## Persistence and queues

PostgreSQL is authoritative. Accepting a message writes the message, one delivery per recipient, and outbox events in
one transaction. The message retains immutable From, To, Cc, Bcc, Reply-To, headers, thread references, and attachment
snapshots. A recipient delivery retains its role. A submission groups the actual envelope recipients, and submission
attempts record provider calls; a submission-to-delivery mapping permits recipient results without changing visible
headers. Bcc never appears in visible headers. BullMQ job payloads contain only internal identifiers. A lost or duplicated queue job is recoverable
from PostgreSQL and cannot create an additional attempt after an accepted attempt exists.

Raw MIME, large native payloads, and attachments are written to the configured object store. The database stores
metadata and object keys. Local object storage is development-only; production should use an encrypted S3-compatible
bucket.

## Sender authorization and presets

An active sender grant authorizes a product or one of its services to use an active sending domain, optionally restricted
to one exact local part. Domain verification and caller authorization are independent controls. Acceptance, submission,
and manual retry enforce the current product, domain, and grant state. Removing a grant blocks future submissions.

Sender profiles are optional console presets. Selecting one expands its From, Reply-To, and category fields into a normal
mail request. The API accepts complete mail parameters without a preset, and accepted mail does not reference profiles.
Editing or disabling a preset never mutates queued snapshots or grants/revokes sending permission.

## Routing

Each routing policy is bound to one sending domain, then evaluated against product, service, and category. It matches required mail features against provider capabilities and
removes targets whose provider account is disabled or unhealthy, whose identity is not verified for that same domain,
whose circuit is open, or whose quota or account/identity rate limit is exhausted. It then selects the lowest priority
tier and performs deterministic weighted selection.

Every attempt stores:

- the selected policy and target;
- candidate eligibility, required capabilities, and routing decisions;
- the provider account and verified identity;
- a request fingerprint and provider idempotency key, when supported;
- the determinate or unknown outcome and canonical error classification.

The same visible From domain must be verified on every target used for failover.

## Failure semantics

Failover is allowed only after a provider response proves that the request was not accepted. An external message ID is a
point of no return and prevents provider switching. Network timeouts and response loss produce an `unknown` attempt; the
reconciliation worker checks the original provider before any retry.

Hard bounce, complaint, invalid recipient, and policy rejection do not trigger provider failover. Native idempotency is
a capability and is used only by providers that support it. The admin console requires an explicit duplicate-risk
acknowledgement before manually retrying an unknown delivery.

Delivery facts are independent dimensions:

- lifecycle: `queued`, `submitting`, `accepted`, `deferred`, `delivered`, `bounced`, `failed`, `unknown`, `canceled`;
- engagement: `unopened`, `opened`, `clicked`;
- compliance: `clean`, `complained`, `unsubscribed`, `suppressed`.

Event application locks each delivery, deduplicates stable source keys, and applies deterministic timestamp/state precedence. Local transitions and provider events commit canonical facts, projections, suppression effects, and callback outbox work together. Engagement does not regress from clicked to opened. Terminal facts may resolve an earlier transient state even when the transient write arrived later.

## Provider setup

Create a provider account in the operations console, enter its public configuration and write-only credential, then test
connectivity. Credentials are never returned by the API. Rotation creates a new credential version, disables its routing
eligibility until a successful fresh connection test, and revokes the prior version in one transaction.

Register an inbound-only domain in **Domains** without selecting outbound providers. To enable sending, create or associate a sending domain in **Domains** and select the provider accounts that should carry it. For Resend,
Envoy searches the account's domains with the official SDK, retrieves an existing domain's current status and DNS
records, and creates a domain only when no match exists. **Refresh DNS** also recovers a failed association this way.
For Amazon SES, Envoy creates the provider identity and displays its DNS records. For SendGrid, Mailgun, and Postmark,
operators first verify the domain in the provider dashboard, then explicitly associate that existing verification with
the account. Mailgun can be associated only with the exact sending domain configured on its account. Routing targets
become eligible only after the relevant identity is verified.

Supported modules:

| Provider   | Webhook security                                             | Inbound mode                       |
|------------|--------------------------------------------------------------|------------------------------------|
| Resend     | Svix signature and replay window                             | Webhook plus API fetch             |
| Amazon SES | SNS certificate signature and expected TopicArn              | Receipt Rule plus S3/SNS reference |
| SendGrid   | ECDSA signed event webhook and Inbound Parse                 | Multipart Inbound Parse            |
| Mailgun    | Timestamp, token, and HMAC signature                         | Routes multipart payload           |
| Postmark   | Basic Auth, opaque endpoint, IP allowlist, schema validation | Inbound webhook                    |

Postmark does not advertise a nonexistent HMAC mechanism.

### Provider account setup

The operations console uses provider-specific fields rather than exposing internal JSON documents. Provider API hosts are
fixed to their official endpoints; operators can select a documented region where the provider offers regional APIs but
cannot redirect authenticated requests to an arbitrary host.

| Provider   | Connect account with                                            | Optional account settings                         | Configure after creation                              |
|------------|-----------------------------------------------------------------|---------------------------------------------------|-------------------------------------------------------|
| Resend     | API key                                                         | None                                              | Webhook signing secret                                |
| Amazon SES | Runtime IAM credentials, an assumed role, or AWS access keys    | Region and configuration set                      | Expected SNS Topic ARN                                |
| SendGrid   | API key with Mail Send permission                               | Global or EU API region                           | Event Webhook key; optional separate Inbound Parse key |
| Mailgun    | API key and sending domain                                      | US or EU region                                   | Account webhook signing key                           |
| Postmark   | Server API token                                                | Message stream, defaulting to `outbound`           | Basic Auth credentials and optional source allowlist  |

Sending credentials and event-webhook verification material have separate encrypted lifecycles. Provider Accounts
generates the opaque provider-event URL first. The operator then registers that URL in the provider dashboard and saves
the verification material returned by the provider. For Postmark, saving Basic Auth generates a one-time,
credential-bearing provider-event URL to paste into Postmark instead of the bare opaque path. This ordering mirrors the
provider setup flow and allows sending to be configured without inventing webhook values in advance.

After account creation, copy the opaque endpoint displayed under **Provider Accounts** into the provider console. Never
place a provider credential in that URL. **Provider Accounts** owns provider event-webhook setup; **Callbacks** only
configures outbound canonical callbacks to business services. Envoy redacts authorization headers before raw event
persistence and persists the verified receipt and security version. Workers parse that accepted receipt without requiring a fresh signature window or current verification key.

### DNS and identity workflow

1. Create the provider account and run **Test connection**.
2. Create a sending domain and select every provider that may carry it.
3. For Resend and SES, publish the returned DKIM, SPF, return-path, and ownership records at the authoritative DNS
   provider, then use **Refresh DNS** until each intended identity is verified.
4. For SendGrid, Mailgun, and Postmark, complete the provider's domain-verification workflow first; Sending Domains
   records the operator-confirmed association and does not invent DNS records or a verification API. A Mailgun
   association must exactly match that account's configured sending domain.
5. Grant the product or service permission to use the domain or exact sender address, and create routing policies for that domain. Runtime routing rejects disabled domains,
   mismatched policy/account/identity domains, mismatched account/identity pairs, and unverified identities.

SES inbound requires a Receipt Rule that stores MIME in S3 and publishes the receipt event to the configured SNS topic.
SendGrid Inbound Parse and Mailgun Routes post multipart payloads to the opaque endpoint. Resend posts the receive event
and Envoy fetches the message through the provider API. Postmark posts the full inbound payload.

For SendGrid, Event Webhook and Inbound Parse use independently configured signature-verification keys. Inbound Parse
also requires its receiving domain, MX record, and security policy to be configured in the SendGrid dashboard.
The connection test makes a deliberately invalid Mail Send request, so it verifies the permission Envoy actually uses
without delivering a probe email or requiring unrelated profile permissions.

## Inbound safety

Inbound routes match a verified provider endpoint and trusted SMTP envelope recipients by exact domain and local-part
pattern. Sender grants and outbound identity verification are separate from receiving-route configuration. Every matching
route participates; overlapping routes merge into one service-owned copy, and multiple services receive private copies.
The deduplication key is provider account + external transport message identity + service (or administrator-only product
scope). Identical patterns may explicitly target different services. Bcc/envelope recipient data are filtered per copy;
visible To/Cc remain content headers. Raw MIME is administrator infrastructure data and has no service download API.
Callback endpoints are checked against the copy's service and subscription at enqueue and delivery time, even if route configuration is inconsistent. Each route exposes its own notification status separately from ingress configuration; an unbound route is polling-only.

Trusted sources in the adapters are:

| Provider | Ownership source | Standard fields |
|---|---|---|
| SES | Signed SNS `receipt.recipients`, not `mail.destination` or MIME headers | Parsed MIME Message-ID, Reply-To, In-Reply-To, References |
| SendGrid | Signed Inbound Parse `envelope.to`; malformed/missing envelopes stay unknown | MIME headers, including raw MIME mode |
| Mailgun | Authenticated route payload `recipient`, with no To fallback | `message-headers`; transport token remains distinct from RFC Message-ID |
| Postmark | Authenticated inbound `OriginalRecipient`, never ToFull/CcFull | `Headers` for RFC IDs plus `ReplyTo`; provider MessageID remains separate |
| Resend | Unknown under the currently verified retrieval contract; quarantined | Retrieved message_id and standard headers are preserved for diagnosis |

Authoritative references: [SES receiving contents](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-contents.html),
[SendGrid Inbound Parse](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook),
[Mailgun route payload](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-http),
[Postmark inbound webhook](https://postmarkapp.com/developer/webhooks/inbound-webhook), and
[Resend received-email retrieval](https://resend.com/docs/api-reference/emails/retrieve-received-email).
The last contract does not establish that its To/Bcc fields are SMTP envelope facts, so the adapter does not infer ownership.
Missing or invalid envelopes and unmatched mail remain administrator-only with stable rejection codes. Old Date headers
are content, not the database observation time reported as receiving evidence. Routes without a service remain
administrator-only and cannot leak into a product's services.

Raw MIME and attachments are size-limited and stored privately outside PostgreSQL; HTML is sanitized before persistence.
Both directions register byte-bound persistent safety tasks. Inbound body readiness is separate from attachment usability.
No attachment download or outbound submission is permitted without a current clean proof. Missing scanning fails closed.
The business callback receives only canonical metadata and Envoy identifiers.

## Suppression policy

- Hard bounce and invalid mailbox may create a global suppression.
- Complaint creates a permanent global suppression.
- Unsubscribe is scoped to a product or list.
- A single soft bounce never creates a permanent suppression. Repeated soft bounces cross a threshold and create an
  expiring suppression.

## Credential security

Every provider or callback secret is encrypted with an independent random data encryption key using AES-256-GCM. The
resource ID and credential version are authenticated as AAD. The data key is wrapped by `ENVOY_KEK_BASE64`; production
deployments should source that root trust from a KMS-backed secret injection mechanism. Workers decrypt credentials only
immediately before a provider call. Secrets never enter logs, queues, or caches.

`ENVOY_KEK_VERSION` labels new envelopes. During root-key rotation, `ENVOY_KEK_KEYRING_JSON` supplies prior
version-to-key mappings until those envelopes are rewrapped; an unavailable version fails closed.

For Amazon SES, `roleArn` and optional `externalId` enable workload identity through AssumeRole. Static access keys are
supported only as an encrypted fallback.

## Canonical callbacks

The **Callbacks** page configures outbound canonical callbacks to business services. Provider event-webhook setup lives
under **Provider Accounts**.

Callbacks contain Envoy message, delivery, inbound, product, category, and recipient identifiers. They never expose
provider account IDs, native event names, or provider payloads. Requests are signed as
`HMAC-SHA256(timestamp + "." + body)` and retried with exponential backoff. Exhausted callbacks enter the dead-letter
state and can be replayed from the console.

Consumers should reject stale timestamps, compare signatures in constant time, and deduplicate on the stable
`x-envoy-id` header. Callback delivery is at least once.

## Service API

The versioned service API is discovered at `/api/v1` and described by `/api/v1/openapi.json`. A service credential is
scoped to one product and service. Ownership filters are applied to every message, delivery, event, inbound message,
and suppression operation.

Every service uses the fixed `SERVICE_REQUESTS_PER_MINUTE` request limit. The effective value is returned by
`/api/v1/capabilities`; it is not a per-service administrator setting.

Message acceptance is asynchronous and idempotent. A successful request commits the message, one delivery per
recipient, and durable outbox work before returning `202`. The API also exposes cursor-paginated message, delivery,
event, and inbound collections; sender authorization, receiving-route and evidence discovery; private attachment upload; product suppression management; pre-provider cancellation;
and controlled retry. An `unknown` delivery can only be retried when the caller explicitly acknowledges duplicate risk.

## Diagnostics

The service API uses RFC 9457 problem responses with `requestId`. Request records are scoped to the calling service and
remain queryable when validation or authorization failed before a message ID existed. Message and delivery queries,
submission attempts, events, and signed callbacks share structured diagnostic fields: stable code, sanitized message,
failed stage, provider acceptance certainty, retryability, retry decision, occurrence time, and available provider/SMTP codes.
The console shows the accepted headers, recipient role, failure reason, attempts, and complete event payloads. Internal
provider routing snapshots remain available to administrators. Retention of content and request/diagnostic history is independent.

See [API.md](API.md) for the final public contract.

## Operational recovery

- A determinate provider rejection may use the next eligible account. Authentication, quota, rate, health, verified
  identity, policy priority, target priority, and weight are evaluated before every attempt.
- A transport ambiguity becomes `unknown` and is reconciled against the original provider. Envoy never performs
  automatic cross-provider failover from an unknown outcome.
- Repeated retryable provider, network, or rate-limit failures open the target circuit. An expired circuit is probed and
  closes after a successful acceptance.
- Exhausted provider quota or temporary lack of a healthy route moves the delivery to `deferred` and schedules a durable
  re-evaluation.
- Raw provider events and callback deliveries are replayable from the console. Manual retry of an unknown delivery
  requires explicit duplicate-risk acknowledgement and is always audited.

## PostgreSQL runtime

BullMQ uses an explicit PostgreSQL backend factory and a dedicated `bullmq` schema. Business transactions retain an
Outbox: BullMQ's public API uses its own pool and does not join a business `PoolClient` transaction. Dispatch uses the
Outbox ID as the stable job ID. A crash after enqueue but before publication marking is safe to replay. State-based,
bounded recovery replenishes missing delivery, reconciliation, event, inbound and callback work; published rows are not
blindly replayed. PostgreSQL notifications only wake workers; durable table state survives disconnections.

`pnpm db:migrate` applies both business and BullMQ migrations. Startup validates queue schema compatibility and does
not implicitly migrate. Use PostgreSQL 14+ and direct or session-pooled connections; LISTEN must keep a session.
With default business pool 10 and queue pool 2, a Web process budgets up to 18 connections and a Worker up to 30
(including four LISTEN connections). One of each needs capacity for 48 plus migrations, monitoring and headroom;
replicas multiply these limits. Configure `DATABASE_POOL_SIZE` and `QUEUE_POOL_SIZE` together.

Shared fixed-window limits use database time, advisory locking and atomic UPSERT. Provider and identity reservations
commit together or neither is consumed. Login protection fails closed if storage is unavailable. Worker heartbeats
expire after 45 seconds; the public health endpoint checks database/schema readiness separately from operational
pipeline health.

## Bounded recovery and retention

Provider calls have one 30-second submission deadline and no implicit non-idempotent SDK retry. A submission execution
lease lasts two minutes. Current attempt and submission ownership fence lifecycle projections while historical
provider facts remain available. Unknown attempts keep their uncertainty when an operator authorizes a fresh submission. Current suppression, product, sender authorization, accepted domain and content eligibility
are rechecked at the send and retry boundary. Sender and From information are immutable acceptance snapshots.

Missing routes defer for at most 60 cycles. Automatic reconciliation stops at 12 checks. An unassociated accepted raw
event retries for at most 20 passes and remains visible for operator replay. Callback timing and attempts are owned by
the database; exhausted delivery enters dead-letter state with scoped replay. Inbound processing claims one execution
lease, so duplicate work does not create duplicate attachments or callbacks.

Optional retention is an explicit dry-run/apply command. It clears eligible terminal content and objects, not message
IDs, payload hashes or idempotency summaries. Active and unknown work is excluded. Age-based cleanup deletes objects before marking references purged. Explicit service content erasure instead commits tombstones and durable deletion intents first, so access revocation survives object-store failures; the same reference-aware cleanup retries physical deletion. Purged attachments cannot be downloaded.

Server processes and database sessions use UTC; API timestamps are UTC ISO 8601 (`Z`). The console formats timestamps in the current browser timezone and labels that zone. Cohort/rate/quota windows are UTC and labeled explicitly.


## Business connection boundary

Envoy alone manages domains, provider identities/credentials, DNS instructions, sender grants and inbound routes.
The domain administrator publishes records in the real DNS platform; Envoy detects/presents provider results. A business
service binds its service key and chosen addresses, supplies native mail content, retrieves owned resources and consumes
signed canonical events. It never holds administrator credentials or manages domain verification.

The `mail` discovery object describes address permissions, not physical mailboxes. Domain grants are never expanded to
invented mailbox lists. Inbound patterns describe only configured routes and do not prove all addresses can receive.
Configuration readiness, actual canonical send/receive facts, and callback HTTP delivery are independent dimensions.
Runtime capacity and external receiving reachability remain unknown at discovery; no missing evidence is synthesized.
An HTTP-success callback says nothing about the caller's conversation or ticket processing. See the exact status/error
contract in [API.md](API.md#business-mail-connection-and-discovery).

## Inbound clocks, dispatch plans and committed change streams

`author_date` is optional untrusted content; `ingress_received_at` comes from the durable verified raw receipt;
`created_at` records private-copy observation/storage; `ready_at` records completion of sanitized body storage.
Public `receivedAt` records copy storage time. Lists preserve PostgreSQL microseconds; incremental recovery uses `/inbound-changes` and not temporal scans.
Retention uses the later of storage and ready time, protecting delayed scans and recently received old mail. Unknown timestamps remain null; no history is guessed.

`inbound_receipts` persists the first normalization decision, keyed by provider account plus transport receipt identity.
Its content-free route snapshot fixes service scopes, matched recipients and selected callback IDs. Subsequent retries
ignore newly added routes; retained original scopes never expand implicitly. Each service group processes in a separate
transaction/claim, and processing continues after another group's transient failure before requesting a raw-event retry.
Ready/purged copies are deduplication tombstones; retries do not upload them again. Runtime callback checks remain live,
so a historical binding does not grant access to a new endpoint owner. Explicit raw termination fences unfinished work.

An update trigger appends `inbound.available` when a private copy becomes ready and `inbound.content_purged` on its first
purge. The change and resource update share a transaction. Each service has an `inbound_streams` row with a transactional
position, generation and retained floor. Allocating a position updates that row; its write lock stays held through commit.
A reader takes FOR SHARE on the same head and reads only its committed prefix. Thus an uncommitted lower position cannot
appear after a reader advances, including rollback, delayed commits, concurrent paged reads and late processing. Numeric
positions are ordered as bigint, never lexically. Different services do not share a counter/authorization boundary.

Pages contain 1–100 content-free changes, reusable event/page checkpoints, a watermark and retention boundary. The
90-day cleanup locks the head and removes only an expired prefix; it cannot create gaps in the middle. A cursor below
the floor or from an old generation yields a stable 410 with explicit gap/reset information; omission starts at the floor
and advertises any truncation. Business consumers reconcile retained resources and record lost history before a reset.
This feed is independent of the outbound `/events`, callback delivery, and business processing state.

## Credentials, actual mail identity and content lifecycle

Service rotation inserts a new credential under the same service and bounds the old credential's overlap to 24 hours
(or its earlier expiry). A once-shown key, separate IDs, approximate usage timestamps and rotation/revocation audit support
a staged caller switch; immediate revoke remains available. Callback retries use the current endpoint signing version;
`x-envoy-key-version` identifies the signing secret version independently of payload API versions/algorithm versions.
Consumers preinstall both secrets, switch the endpoint, then drain old requests before removing old verification.

Submission attempts store a nullable confirmed `rfc_message_id`, separate from the Envoy resource/submission ID and
provider `external_message_id`. Postmark sends an attempt-specific documented custom RFC header and confirms it after
acceptance; Mailgun uses a valid returned RFC ID. SES overwrites MIME IDs; SendGrid/Resend current paths and unknown
responses lack confirmed final RFC headers. They stay null. No shared/guessed RFC ID is manufactured across submissions.
Native threading facts support caller-managed conversations without introducing conversation models into Envoy.

Explicit service content erasure locks owned resources and active work, clears body/attachment/callback content and
commits irreversible tombstones plus reference-aware object deletion intents. Inbound copies authorize independently.
Shared files and administrative raw receipts remain until their other retained references no longer require them;
provider-side source objects are outside the service erasure contract. Active/unknown sends, active scans and in-flight
callbacks conflict instead of racing deletion. Future provider facts can still update minimal delivery history, but
cannot enqueue content callbacks for a purged message. Deduplication, idempotency and scope/audit facts survive; replay
never reconstructs purged content. Caller caches and backups require their own lifecycle controls.

Dead letters mean recoverable work. Explicit audited termination is separate from delivered success and from content
purge/age retention. Callback termination releases retention gates without fabricating an HTTP success. Raw-event
termination fences frozen dispatch, rejects unfinished copies and preserves completed copies. Terminated/purged work
cannot be replayed. The existing transport timeout does not implement a business verification-code deadline; scheduling
and expiry enforcement remain outside the current send contract.

## Shared attachment safety

`modules/attachments` owns the scanner protocol, unified availability policy, durable tasks and guarded byte access.
Neither files nor the outbound executor depends on inbound business logic. See [Attachment Safety](ATTACHMENT-SAFETY.md).
`attachment_safety` binds a private resource, expected/scanned SHA-256 and policy version. It stores bounded reason codes,
never engine responses/signatures. `attachment_scan_scopes` persists fair dispatch order, with at most one queued/live
scan per owner; a large service cannot put its whole batch ahead of another. The scheduler atomically writes outbox jobs
and dispatch leases, then the existing PostgreSQL queue executes them. Five claims, finite backoff, two-minute leases
and random fencing tokens handle process death and duplicate tasks. Malicious/blocked verdicts are terminal to retry.

Upload bytes and their task reference commit together after reference-aware object registration. Inbound normalization
stores each private attachment and task with body readiness/callback publication. The task reads bounded bytes, verifies
the immutable digest, scans outside locks, then locks parent/resource/safety in that order and commits only its current
lease result. Purge triggers invalidate leases and revoke usability. Delayed results never recreate objects or content.

Admission locks every owned file/proof and rejects unapproved files before creating message/idempotency records. The
executor preserves its existing attempt/unknown logic and takes shared resource/proof locks through preparation and
provider submission. All normal/inline attachments are loaded and digest-verified before the single provider boundary;
current policy is checked again after I/O. A read-only guard commit failure cannot discard a definitive provider response.
Downloads apply the same proof/digest checks while erasure/reprocessing waits on resource locks. These locks authorize
an in-flight read; they cannot recall a previously downloaded copy. Retention semantics of `contentAvailable` are unchanged.

This new project retains only its authoritative initial schema and final contract. There are no legacy scan adapters,
unchecked-content bypasses, migration-adoption patches, provider capability compatibility views or automatic historical resends.
