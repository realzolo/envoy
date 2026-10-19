# Service API contract

Envoy exposes one native-mail service API at `/api/v1`. `GET /api/v1` lists resources;
`GET /api/v1/openapi.json` is the machine-readable schema. Provider selection and credentials stay internal.

## Authentication and authorization

Use `Authorization: Bearer <service-key>`. Each key belongs to one service and product. Resource ownership is checked
on every request, including files, events, and request diagnostics; another service's identifiers are not accessible.
`GET /capabilities` returns product/service identity, current limits, native mail features, explicit domain sending/receiving permissions, configuration status and observed evidence. See the business connection contract below.

An administrator grants each business Service explicit domain sending/receiving permissions under **Service Credentials**. Product-wide inheritance and exact-address grants are not supported. Verification
of a domain on a provider is a separate prerequisite. A caller may directly specify any authorized From address and name.
Both API submissions and console test messages supply From, Reply-To, and category directly.

## Submit a mail message

`POST /messages` requires JSON and an `Idempotency-Key` header.

```json
{
  "from": { "email": "orders@mail.company.com", "name": "Order service" },
  "to": [{ "email": "customer@example.com", "name": "Customer" }],
  "cc": [{ "email": "manager@company.com" }],
  "bcc": [{ "email": "archive@company.com" }],
  "replyTo": [{ "email": "support@company.com", "name": "Support" }],
  "subject": "Order confirmation",
  "html": "<p>Your order is confirmed.</p>",
  "text": "Your order is confirmed.",
  "category": "transactional",
  "attachments": [{ "fileId": "file_example", "disposition": "attachment" }],
  "headers": { "X-Business-Order": "123" },
  "referenceId": "order_123",
  "tags": { "purpose": "confirmation" },
  "metadata": { "orderId": "123" }
}
```

| Field | Contract |
|---|---|
| `from` | Required `{email,name?}`; the From domain must have current Service sending permission |
| `to`, `cc`, `bcc` | Arrays of `{email,name?}`, default empty; 1–50 recipients combined, unique across roles |
| `replyTo` | Array of `{email,name?}`, default empty, at most 10 addresses |
| `subject` | Header-safe string, defaults to empty, at most 998 characters |
| `sendBefore` | Optional future UTC ISO timestamp ending in `Z`; prohibits new provider submissions at or after this instant |
| `contentPolicy` | `normal` (default) or `sensitive`; sensitive requires `sendBefore` within the next 900 seconds |
| `html`, `text` | At least one nonempty body; at most 2,000,000 UTF-8 bytes each |
| `category` | Stable lowercase key, default `transactional`, 2–80 characters |
| `attachments` | At most 20 private file references; at most 20,000,000 bytes combined |
| `headers` | At most 30 case-insensitively unique custom headers; reserved transport, identity, MIME, signing, tracking, and thread headers are rejected |
| `inReplyTo` | Optional bracketed RFC message ID, such as `<original@example.com>` |
| `references` | Up to 50 bracketed RFC message IDs, default empty |
| `referenceId` | Optional business correlation key, up to 160 characters |
| `tags`, `metadata` | Optional maps, at most 20 entries each; see OpenAPI for key/value bounds |

Unknown fields and unsafe header values are rejected. The JSON body is limited to 4,200,000 bytes. The platform routes
only to providers that support the message's required features. Unsupported native fields are never silently discarded.

To/Cc/Bcc retain mail semantics: visible To/Cc headers are preserved while actual envelope recipients are tracked
individually. Bcc addresses never enter visible headers. A recipient delivery record is not a separate rewritten mail.
An all-Bcc request is valid. Failures or suppressions affect actual delivery eligibility without exposing Bcc or changing
the accepted header snapshot. Retry targets eligible failed recipients while preserving the original visible headers;
a provider that cannot safely express the required envelope cannot carry that submission.

A `202` response is a durable receipt after the message snapshot, recipient records, and Outbox work commit together.
It returns `id`, `processingState: "queued"`, `outcome: "pending"`, recipient count, and acceptance time. It does not
claim that a provider accepted the mail or that an inbox received it.

The key is scoped to the service. Repeating a key with the same normalized request returns the same acceptance receipt;
reusing it with different content returns `409`. Keep the same key after an HTTP timeout. Message IDs and idempotency
summaries survive optional body cleanup.

## Sending deadline and sensitive content

`sendBefore` is a latest **submission** time, independent of the worker execution lease and mail category. Admission, claims, manual retries, determinate-rejection failover and reconciliation-triggered resubmission check it. After attachment, credential, DNS and TLS waits, the transport rechecks current domain authorization, the execution lease and the deadline immediately before writing HTTP headers/body. A pre-submit expiry produces `failed` with `SEND_DEADLINE_EXCEEDED`, acceptance `not_accepted` and no retry. Once bytes may have been sent, lost responses remain `unknown`; existing accepted/unknown attempts continue factual reconciliation and are never declared expired merely to permit resending. Upstream providers may deliver already accepted mail later; this field cannot recall it.

Use `contentPolicy: "sensitive"` for content that must not be inspectable in Envoy. The sender/recipient display names, subject, bodies, Reply-To, custom/thread headers, attachment presentation, tags and metadata are encrypted in one AES-256-GCM envelope, bound to the message ID. Only send preparation opens this envelope. API/admin queries return `[Sensitive content]`, null bodies, empty metadata/tags/headers/thread fields and no message attachment details. Minimal envelope email addresses, category, opaque reference/request IDs and delivery facts remain available. Keep secrets out of these retained identifiers and independently uploaded file bytes/names; sensitive message policy does not redefine the separate reusable-file lifecycle. Inline public branding assets remain supported.

Sensitive requests require a deadline no more than 900 seconds in the future. Their encrypted content becomes unusable for submission at that deadline and is removed by the mandatory worker privacy sweep, normally within its 10-second interval. This sweep runs independently of optional normal-content retention; worker downtime delays physical removal, while send/read restrictions remain in force. It preserves minimal message/receipt/callback facts. Request and provider fingerprints use KEK-versioned HMACs to prevent offline guessing of short sensitive values; retain old KEKs needed for durable idempotency verification. Identical service key/payload replays resolve **before** deadline and retention checks, even after the encrypted body is gone. Changing the policy or deadline under an existing key is a conflict.

All provider raw bodies, headers and verified receipts are envelope-encrypted before DB/object storage. Outbound receipts are erased after successful normalization; verified outbound receipts first freeze a whitelist of content-free normalized facts. Their raw copies have a 900-second privacy deadline even before association; durable normalized replay remains available after raw removal. Unknown classifications and inbound receipts are not assigned this outbound deadline. Inbound receipts keep their independent recovery/retention lifecycle. Sensitive canonical events, callback data, provider responses and diagnostics retain only delivery facts and fixed diagnostic text, never provider free-text echoes of the original message.

Discovery exposes the exact gate below. Callers requiring sensitive/deadline handling must fail closed when these features are absent:

```json
"messagePolicies": {
  "sendBefore": true,
  "contentPolicies": ["normal", "sensitive"],
  "sensitive": { "requiresSendBefore": true, "maxRetentionSeconds": 900, "contentReadable": false }
}
```

`POST /messages` and message-level `acceptedAt` indicate durable Envoy queue acceptance. In `GET /messages/{id}`, each delivery now includes nullable `acceptedAt` and `deliveredAt` from its provider/recipient facts. Provider lifecycle `accepted` keeps message outcome `pending`; `succeeded` means all recipient lifecycles are `delivered`. A provider event can confirm delivery without supplying an earlier acceptance timestamp; do not synthesize that timestamp from the local 202 receipt.

## Files and inline images

Upload raw bytes to `POST /files`, using the service credential, the media type in `Content-Type`, and the URI-encoded
UTF-8 filename in `X-File-Name`. Each file is limited to 10,000,000 bytes.

```bash
curl --request POST http://localhost:6178/api/v1/files \
  --header "Authorization: Bearer $ENVOY_SERVICE_KEY" \
  --header 'Content-Type: application/pdf' \
  --header 'X-File-Name: invoice.pdf' \
  --data-binary @invoice.pdf
```

The `201` result confirms durable private storage and a pending safety job; it does **not** mean the file can be sent.
It contains `id`, filename, media type, byte size, SHA-256, `contentAvailable`, `usage`, and creation time.
Wait until `usage.canSend` is true before referencing its `id` as `fileId`. Unapproved references fail with 409
`FILE_NOT_READY` or `FILE_UNAVAILABLE` before message acceptance; the same business idempotency key remains reusable.
`GET /files/{id}` retrieves owned file metadata. Attachment items accept optional `fileName` and default disposition
`attachment`; `inline` requires a unique `contentId`, referenced in HTML as `cid:contentId`.

## Query results and diagnose failures

| Resource | Purpose |
|---|---|
| `GET /messages` | Cursor-paginated mail search, including `referenceId`, `processingState`, and `outcome` filters |
| `GET /messages/{id}` | Immutable sender, recipient/header/body/attachment snapshot, per-recipient results, processing and outcome summary |
| `GET /messages/{id}/events` | Canonical timeline, with event scope and diagnostics |
| `GET /messages/{id}/attempts` | Submission attempts, affected recipients, outcome certainty, and structured errors |
| `GET /deliveries` and `GET /deliveries/{id}` | Recipient role, lifecycle, engagement, compliance, attempts, and events |
| `GET /events` | Cursor-paginated outbound canonical events (scope unchanged) |
| `GET /inbound-changes` | Durable inbound availability/purge changes, scoped to the service |
| `DELETE /{messages,inbound-messages,files}/{id}/content` | Idempotent guarded content erasure |
| `GET /requests/{requestId}` | Request result and problem details, including failures before a message ID was created |
| `POST /messages/{id}/cancel` | Cancel eligible recipients before crossing the provider boundary |
| `POST /messages/{id}/retry` | Retry eligible recipients; unknown outcomes require explicit risk acknowledgement |
| `/suppressions` | Query, create, and remove product-owned suppressions |
| `/inbound-messages` | Query sanitized inbound mail and eligible private attachments |

Every authenticated response carries `x-request-id` and rate-limit headers. Save the request ID even for rejected
requests. Problem responses use RFC 9457 `application/problem+json`, with `type`, `title`, `status`, `detail`, `requestId`,
and a stable `code` plus field errors when relevant. Querying that request ID with the same service credential closes the diagnostic gap
before a mail record exists. Request logging failure is reported by the server rather than changing accepted mail state.

Message `processingState` is `queued`, `processing`, or `finished`. `outcome` separately reports `pending`, `succeeded`,
`partially_failed`, `failed`, `canceled`, or `unknown`; counts and recipient states explain mixed outcomes. Provider
acceptance is not inbox delivery. Delivery lifecycle is `queued`, `submitting`, `accepted`, `deferred`, `delivered`,
`bounced`, `failed`, `unknown`, or `canceled`. Engagement and compliance are independent dimensions.

Structured diagnostics include:

- `code`, a stable machine-readable error; `message`, a sanitized actionable description; `stage`, the failed stage.
- `acceptance`: `not_accepted`, `accepted`, or `unknown`; `retryable`, whether retry conditions exist.
- `retryDecision`: action `scheduled`, `none`, or `manual_review`, with reason and next time when applicable.
- Available `providerCode`, `smtpStatus`, and `occurredAt`.

Errors before a provider call (for example revoked sender authorization) are recorded even though no provider attempt
exists. Trace the chain `requestId → messageId → submissionId → attemptId`, with delivery IDs for recipient results.
Administrator queries additionally expose routing snapshots and operational detail; provider secrets are never public.

## Retry and event semantics

Explicit non-acceptance from a provider permits safe retry/failover if the error and route allow it. A timeout or lost
response becomes `unknown`; Envoy reconciles against the original provider and does not automatically switch providers.
An accepted provider submission is followed through provider events. A provider-managed delivery deferral cannot be
manually resubmitted while the provider is still handling it. Permanent bounces, complaints, and suppressions
are not ordinary retryable submissions. Revoked authorization, disabled product/domain, suppression, and expired content
are rechecked before send and manual retry. Provider-native idempotency is reused where supported and within its window.

`POST /messages/{id}/retry` requires its own `Idempotency-Key` header and takes `{"acknowledgeDuplicateRisk":false}` by default; optional `deliveryIds` selects specific recipient records. Unknown retries require `true`, are
audited, and retain the original attempt's unknown fact. Already successful recipients are not repeated. Automatic
routing deferral and reconciliation are bounded; exhausted work remains inspectable with a specific reason.

Callbacks use the same canonical event and diagnostic model as polling. For lifecycle events, callback `data.lifecycle`
expresses the event fact; `data.currentLifecycle` is the current recipient projection. A late historical event can therefore
report `delivered` while a separately authorized newer submission is still `submitting`. Events may be repeated or arrive out of order;
deduplicate by stable event ID and query the current resource when necessary. Submission-scoped provider events remain
submission-scoped rather than inventing recipient attribution. Verify HMAC-SHA256 over `timestamp + "." + original UTF-8 body`
with one current secret, enforce at most 300 seconds of absolute clock skew, and durably deduplicate `x-envoy-id`.
Configure the business callback URL and secret through administrator settings.

## Retention and time

API timestamps use UTC ISO 8601. The console formats them in the browser timezone. Message bodies, attachment bytes,
request diagnostics, and audit details have separately configured retention. Active or unknown mail is protected from
content cleanup; identifiers, state, errors, and idempotency summaries remain useful after body removal. Check
`contentAvailable` and content-purge fields before depending on stored content.

## Business mail connection and discovery

Business configuration consists of one Envoy URL, a Service Key, and optionally one business callback URL and signing secret. A Service can use multiple explicitly authorized domains. Business APPs, exact address purposes, templates and APP routing belong entirely to the caller; Envoy never needs APP identifiers or a mailbox entity.

`GET /capabilities` returns `product`, `service`, limits and native features plus:

```json
{"kind":"domain_permissions","domains":[{"id":"sd_example","domain":"mail.example.com","authorization":"granted","revision":1,"permissions":{"send":true,"receive":true},"sending":{"state":"configured","reasonCodes":[]},"receiving":{"state":"configured","reasonCodes":[]},"notification":{"mode":"callback_and_polling","state":"configured","reasonCodes":[]},"evidence":{"lastAcceptedAt":null,"lastDeliveredAt":null,"lastReceivedAt":null}}],"callbacks":{"configuration":"configured","latest":null,"lastDeliveredAt":null,"businessProcessing":"unknown"}}
```

The example is the `mail` object, not the entire response. Domain IDs are stable `sending_domains` IDs. Permission is independent of DNS and transport readiness. `configured` never guarantees external delivery or receiving; evidence is an actual retained fact or null. No mailbox list is invented. An exact domain grant does not include subdomains. Disabled grants remain discoverable with `authorization:"revoked"` and false effective permissions.

The console's **ALL (current and future domains)** option grants sending or receiving permission to every registered domain, including domains registered after the credential was issued. Sending and receiving can use ALL independently. Discovery resolves ALL to current domain IDs and combines it with any exact-domain grants, returning each domain once. Grants are additive: revoke the ALL grant under **Business domain permissions** to restrict access to exact-domain grants. Disabled domains and suspended Products remain unusable. ALL grants permission only; outbound provider identities/routing and inbound routes must still be configured for each domain.

Reason codes include `DOMAIN_SEND_NOT_AUTHORIZED`, `DOMAIN_RECEIVE_NOT_AUTHORIZED`, `SENDING_DOMAIN_DISABLED`, `INBOUND_DOMAIN_DISABLED`, `NO_ELIGIBLE_ROUTE`, `INBOUND_INGRESS_UNAVAILABLE`, `CALLBACK_DISABLED` and `CALLBACK_EVENT_NOT_SUBSCRIBED`. Handle unknown future codes generically. The send API retains `SENDER_NOT_AUTHORIZED` and `NO_ELIGIBLE_ROUTE` problem codes.

Every protected API rechecks Service ownership and current corresponding domain permission, including files, events, changes, retries, content purge and background callbacks. Sending-only callers can query their own authorized outgoing message/status resources but obtain no incoming resources. Revocation hides known resource IDs as well as list results. A single inbound copy spanning several private envelope domains is indivisible: if any domain loses receiving permission, the complete resource is unavailable rather than exposing a partial unsafe projection.

`POST /files` requires `X-Sending-Domain: mail.example.com` in addition to `X-File-Name`. Files freeze this sending domain, and a message can only attach files from its own From domain. Credentials do not create a domain-independent file pool. Suppression list API calls require the independently enabled `suppression_management_allowed` Service permission, default false; ordinary domain credentials cannot manage product-wide suppression policy.

Key rotation keeps the same Service, domain grants, resource ownership, cursors and idempotency. An idempotent acceptance replay returns the original receipt and never resends the mail; background execution rechecks current permission.

## Inbound ownership, standard fields and callbacks

Routing uses provider-authenticated SMTP recipients, never visible To/Cc/Bcc, `Delivered-To`, `X-Original-To`, arbitrary
MIME headers, or a provider's outbound domain verification status. Sending permission does not confer receiving permission. Domain ingress routes require an explicitly authorized target Service; no Product inheritance or per-address business routing exists.

Every matching route participates. A domain may explicitly target different services. Routes for the same service merge into one copy with the union of matched envelope addresses; each distinct active
callback endpoint selected by those routes receives one event. Other services receive separate IDs and private
attachment ownership. Repeated provider message receipts do not create new copies, attachments or callbacks within
the same service. A retry after a partial fanout resumes unfinished copies and retains successful ones. Mailgun uses
its authenticated transport receipt ID for deduplication rather than an untrusted RFC Message-ID.

`GET /inbound-messages/{id}` adds:

```json
{
  "messageId": "<mail-id@example.net>",
  "envelopeRecipients": ["support@brand.example"],
  "replyTo": ["customer@example.net"],
  "inReplyTo": "<previous@example.net>",
  "references": ["<root@example.net>", "<previous@example.net>"]
}
```

Missing scalar RFC fields are `null`, missing lists are `[]`. A provider's opaque message ID is never substituted for
RFC Message-ID. To/Cc remain visible content headers, not proof of ownership; Bcc and `envelopeRecipients` expose only
addresses matched for the current service. Raw MIME, full provider payloads, and other services' private recipients are
not exposed through the business API. Attachment downloads require that both mail and attachment belong to this service,
ready state, retained bytes, and the current scanning policy.

`inbound.received` callbacks retain their stable event ID and existing envelope and add `productId`, `serviceId`,
`envelopeRecipients`, `messageId`, `replyTo`, `inReplyTo`, and `references` under `data`. Fetch sanitized content and
private attachment IDs through the service API. `GET /events` remains the outbound delivery-event feed; recover inbound
mail through `/inbound-changes`; `/inbound-messages` is a stored-time browse/snapshot API, not an incremental recovery feed. Use the RFC fields to construct a standard
reply (`inReplyTo` and `references`); conversation matching and ticket state remain business rules. Outbound RFC IDs are available per attempt when confirmed; unconfirmed IDs remain null (see below).

Missing/invalid trusted envelopes are quarantined as administrator-only rejected records with
`ENVELOPE_RECIPIENT_UNAVAILABLE`; no matching active route yields `NO_INBOUND_ROUTE`. No service callback is emitted.
Terminal content rejection reasons are stable codes: `INBOUND_MESSAGE_TOO_LARGE`, `INBOUND_ATTACHMENT_TOO_LARGE`,
`INBOUND_MALWARE_DETECTED`. Transient storage/scanner failures remain retryable, rather than becoming a false rejection.

Provider contracts and current adapter behavior are documented in [Architecture](ARCHITECTURE.md#inbound-safety).
In particular, Resend's current adapter deliberately quarantines incoming messages because the retrieved contract does
not unambiguously identify SMTP recipients. Its outbound sending support is unchanged.

## Business connection

Use provider-neutral `mail` discovery for explicit permissions and states. Ownership comes from `envelopeRecipients`,
never visible To. Multiple services receive private resources; null RFC fields/evidence remain unknown. Domain/DNS and
provider configuration stay in Envoy. Send grants do not authorize receiving data.

A runnable minimal connection example is [examples/service-mail.mjs](../examples/service-mail.mjs):

```bash
export ENVOY_URL=https://envoy.internal.example
export ENVOY_SERVICE_KEY='<service-scoped key issued by Envoy>'
export ENVOY_MAILBOX=support@brand.example
export ENVOY_CALLBACK_SECRET='<callback connection secret issued by Envoy>'
node examples/service-mail.mjs discover
node examples/service-mail.mjs send order-123 customer@example.net
node examples/service-mail.mjs inbound
node examples/service-mail.mjs recover
node examples/service-mail.mjs attempts msg_example
node examples/service-mail.mjs reply inb_example customer@example.net
node examples/service-mail.mjs serve
node examples/service-mail.mjs events
```

These commands are examples to run deliberately; `send` and `reply` submit real requests when connected to a real Envoy.
The example callback server verifies timestamps and HMAC, atomically deduplicates by event ID, and durably saves an inbox
receipt before returning 202. `events` reads those receipts and uses the same service key to retrieve inbound content.
Replace its printing with the caller's own transactional business handler and durable processing state; HTTP acknowledgement
still does not mean that handler finished. Envoy operators register the HTTPS callback URL and subscriptions in Envoy;
no provider or DNS setting is supplied by this business process.

## Trusted inbound clocks and recovery

| Field | Meaning |
|---|---|
| `authorDate` | Nullable, untrusted author-declared RFC Date. Old/future dates remain content facts; missing/invalid values are null |
| `ingressReceivedAt` | Time Envoy durably accepted the verified provider receipt. It is not the upstream SMTP server's clock. Unknown values are null |
| `receivedAt` | The private copy’s system storage/observation time (`created_at`). Browse pages use its PostgreSQL microsecond precision plus ID |
| `readyAt` | Nullable system time the sanitized body became business-readable. Unknown completion times remain null |
| Change `recordedAt` | System observation of an atomic availability/purge change, never the mail Date or business processing time |

Inbound callback `occurredAt` records readable body completion (`readyAt`); attachment usability is independent. Delayed normalization separates these clocks. Attachment scanning continues independently after content storage. Content retention starts at the later of
copy storage and processing completion, so a just-readable old email is not immediately expired. Browse snapshots can
include scanning/rejected copies; `readyAt` is not proof that content is still retained. Check `contentPurgedAt`.

`GET /inbound-changes?limit=50&cursor=<opaque>` returns:

```json
{
  "data": [{"id":"ich_example","inboundMessageId":"inb_example","type":"inbound.available","recordedAt":"2026-10-17T08:00:00Z","cursor":"opaque-event-checkpoint"}],
  "nextCursor":"opaque-page-checkpoint", "hasMore":false, "watermark":"opaque-committed-prefix",
  "retention":{"earliestCursor":"opaque-retained-floor","historyTruncated":false,"days":90}
}
```

`limit` is 1–100. IDs are stable across repeated reads. Persist each event or page and its checkpoint durably before
advancing; replaying a cursor is supported. An empty tail still returns `nextCursor`; reuse it on the next poll.
`inbound.available` means content became readable, not that a business handler ran; `inbound.content_purged` means
retained content was removed. Both carry only resource identity and time. Fetch the current resource: an availability
event can precede a purge you have not consumed yet. Callback IDs and change IDs are separate deduplication namespaces;
consuming both transports also requires idempotent resource-level business effects.

Each page reads a bounded committed prefix. Per-service transactional head locks serialize allocation **through commit**;
rollback does not leave an allocated position. A writer cannot commit a lower position after a returned cursor.
New commits during pagination are consumed on later pages/polls; a late author Date or delayed scan cannot move a change
behind the cursor. This contract does not rely on sequence allocation, timestamps or UUID sort order. Services progress
independently. Cursors bind to a service and stream generation; they continue to work after credential rotation.

Changes are kept for at least 90 days and trimmed as a prefix by `data:cleanup --apply`, independently of optional content
policies. No cursor starts at the current tail implicitly. Omitted cursors start at the retained floor and report
`historyTruncated`; applications must handle that as a possible gap. A cursor before the floor or for an old generation
returns **410 `INBOUND_CURSOR_EXPIRED`**, `errors.gap:true` and `errors.resetCursor`. Malformed, future, or other-service
cursors return **400 `INVALID_INBOUND_CURSOR`**. Do not silently reset: reconcile retained inbound resources with your
own durable state, record/alert the irrecoverable gap, then explicitly adopt the reset cursor. Already expired content
cannot be reconstructed by Envoy. Run recovery within your retention window even when callbacks work.

The stored-time list uses `inbound.` browse cursors. Malformed cursors return 400; `/inbound-changes` has independent recovery cursors. `/events` is the outbound feed.

## Receiver notifications and key rotation

`mail.domains[].receiving` describes domain ingress readiness. Each Service has at most one callback endpoint. Its `notification` reports `polling` or `callback_and_polling` and current subscription/configuration errors. No callback is valid polling-only configuration. Receiving uses that business callback automatically; ingress routes never select their own signing secrets or callback endpoints.

Subscribe to `service.permissions_changed` to invalidate cached authorization. This signed event has `{id,apiVersion:"v1",type:"service.permissions_changed",occurredAt,data:{serviceId,productId}}`; it is committed atomically with grant updates/revocation and a durable outbox command. Refresh capabilities to observe the new truth. This notification is independent of now-revoked domain mail access. A bounded cache expiry is still needed if notification delivery fails.

Subscription removal dead-letters affected pending/retrying callbacks; already in-flight HTTP requests may finish. A 2xx acknowledges receipt, not completion of the caller's business processing.

Administrator `credential.rotate` creates a **new credential ID for the same service**, returns the plaintext once,
`previousCredentialId`, `serviceId` and `overlapUntil`. The old key remains valid until its existing expiry or at most
24 hours, whichever is earlier. Switch all callers, verify the new credential's `last_used_at` (coalesced to five-minute
usage observations), then explicitly revoke the old ID. `credential.revoke` is immediate and remains the emergency path.
History, file ownership, rate limits, stream cursors and idempotency are service-scoped, not credential-scoped.
Never distribute administrator keys or provider credentials to perform this switch.

Each Service has one callback endpoint and one current signing secret. Envoy sends exactly three authentication headers:
`x-envoy-id` (stable event ID), `x-envoy-timestamp` (current Unix seconds), and
`x-envoy-signature: v1=<lowercase hex HMAC-SHA256>`. Sign the exact UTF-8 bytes of
`timestamp + "." + rawBody`; `v1=` names the signature algorithm. Verify with the single locally configured secret,
use a constant-time digest comparison, and accept at most 300 seconds of absolute clock skew before parsing the JSON.
Check that `x-envoy-id` equals the authenticated body's ID and deduplicate it durably. Each retry keeps the same event
ID and body and generates a fresh timestamp/signature. Payload `apiVersion` is independent of authentication.

To replace a callback secret, pause the endpoint, wait until its in-flight count reaches zero, replace the single secret
in both Envoy and the consumer, then resume and replay failed callbacks. Administrator `callback.replace_secret` rejects
active endpoints and endpoints with in-flight attempts; it accepts a supplied 16–512 character secret or generates one
shown once. Pausing prevents new dispatches without hiding already in-flight HTTP attempts. Expired attempts are closed
by recovery while paused. Failed callbacks remain replayable after resuming, and `/inbound-changes` provides receive
compensation. Callers must reconcile outgoing message/event resources when notification delivery was paused. The example
uses only `ENVOY_CALLBACK_SECRET`. This operation never changes the Service Key or its Service identity.

## Outbound RFC Message-ID and standard replies

`GET /messages/{id}/attempts` and delivery details add nullable `rfcMessageId` and `rfcMessageIdStatus` (`confirmed` or
`unknown`). An Envoy `msg_...` ID identifies a business resource; `submissionId` identifies an envelope group; an attempt
identifies one provider execution. Provider external IDs remain operational identifiers and are never automatically
converted to RFC IDs. Different attempts/submissions can have different RFC IDs; do not pick an arbitrary attempt when
replying to a multi-submission message. Confirmation is an adapter/API contract fact, not proof of inbox delivery.

| Adapter/path | Confirmation behavior |
|---|---|
| Postmark | Envoy sends an attempt-specific RFC `Message-ID` through the documented custom header; after acceptance the exact header is confirmed separately from Postmark's UUID |
| Mailgun MIME | A syntactically valid RFC Message-ID returned by its messages API is confirmed; opaque/non-RFC responses stay null |
| SES raw MIME | SES overwrites the proposed MIME Message-ID. Its API result is an external ID; no verified actual RFC header is currently available, so null |
| SendGrid / Resend | Current submission paths expose external IDs without confirmed final RFC headers; null |
| Mock | No real RFC transport exists; null |

Lost/ambiguous responses and historical attempts remain unknown unless an adapter has a confirmed fact. The generated
MIME ID alone is not confirmation. Use a confirmed sent RFC ID or an incoming `messageId` with native `inReplyTo` and
`references`; preserve the chain when replying. Conversation grouping and customer support rules remain in the caller.
Provider semantics: [Postmark custom Message-ID](https://postmarkapp.com/developer/user-guide/send-email-with-api/send-a-single-email),
[Mailgun messages API](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages),
[SES header replacement](https://docs.aws.amazon.com/ses/latest/APIReference/API_SendRawEmail.html),
[SendGrid X-Message-ID](https://www.twilio.com/docs/sendgrid/glossary/x-message-id).

## Controlled content erasure and recovery termination

`DELETE /inbound-messages/{id}/content`, `DELETE /messages/{id}/content`, and `DELETE /files/{id}/content` require the
owning service's active key. They are idempotent; unknown/not-owned IDs return 404. Successful requests return 202 with
`id`, stable `contentPurgedAt`, and `objectDeletion:"pending_or_complete"`: the database tombstone and deletion intents
are durable, API access is already removed, physical storage reclamation may still be pending.

- Inbound erasure removes sanitized body/subject, attachment names/content references, raw MIME, and associated callback
  sensitive payloads. Undelivered callbacks become `terminated`; delivered receipts remain delivered with erased payloads.
  Erasing one service copy does not affect another. Related shared administrative raw receipts are erased only when all
  referencing copies/resources are purged and processing is complete/terminated; otherwise they follow their separate
  administrative retention policy. Provider-side source objects and caller-owned copies/backups need their own policy.
- Outbound erasure clears body/subject, custom headers/metadata/tags, attachment snapshots and associated callback payloads.
  Unshared owned files are erased; files still referenced by retained messages remain until their last reference clears.
  A standalone file request returns **409 `CONTENT_SHARED`** while retained message snapshots need it.
- **409 `CONTENT_BUSY`** protects scanning copies, in-flight callback delivery, active recipient sends and unresolved
  attempts. Resolve/finish work first; deletion is not permission to resend an unknown result. Necessary IDs, scope,
  recipient/routing metadata, standard threading identifiers, state, audit and idempotency/deduplication tombstones remain.
  This is content erasure, not an all-PII account deletion API.

Purged copies cannot regain content through duplicate provider events, raw replay, callback replay, retry or recovery jobs.
No purge event contains erased content. Already transmitted callbacks/downloads cannot be recalled; consumers own their
cached data and business retention. Envoy object cleanup runs with `pnpm data:cleanup --apply`, even if age policies are
unset; object failures keep retry intents. Global age retention and explicit service erasure are distinct operations.

`dead_letter` means recoverable work is retained. Operators can replay a scoped delivery after repairing its endpoint/
subscription. Administrator `callback.terminate` permanently changes a dead letter to `terminated`, records an audit,
and leaves `deliveredAt:null`; age retention can then clear its payload/related content. It cannot be replayed or made
successful by compensation. Administrator `event.terminate` can stop an exhausted (20 attempts), inactive raw event:
it freezes the receipt as terminated, rejects unfinished copies with `INBOUND_PROCESSING_TERMINATED`, preserves successful
copies and permits raw-content age cleanup. A terminated raw event cannot be replayed. Termination itself is not a
business deletion request; use the content endpoint/policy to erase retained copies. Restoration from backups requires
preserving/reapplying tombstones and external deletion records before replay.

Verification-code delivery deadlines remain an explicit contract gap: `scheduling:false`, no business expiry/deadline
parameter or deadline-enforced send guarantee exists. The worker's transport timeout is not a code expiry guarantee.
No general scheduling system is added here.

## Unified attachment availability

[Attachment Safety](ATTACHMENT-SAFETY.md) defines the full contract, reasons and upload → poll → send example.
Outbound files and inbound attachments both return `contentAvailable` (retention only) and `usage`:
`state` (`processing`, `usable`, `unavailable`), `safetyState`, `processing`, `canSend`, `canDownload`, nullable `reasonCode`,
`retryable`, and `recovery` (`poll`, `retry`, `none`). Inbound `canSend` is always false; sending a downloaded inbound file
requires a new service-owned outbound upload. No engine address/response, object key or permanent public URL is returned.

- `GET /files/{id}`: query current file availability; upload is 201, usable is an independent result.
- `GET /files/{id}/download`: authenticated safety-approved outbound download.
- `POST /files/{id}/reprocess`: audited, bounded retry of retained recoverable content; 202 `{id,processing:true}`.
- `POST /inbound-messages/{id}/attachments/{attachmentId}/reprocess`: the same recovery for an owned inbound attachment.
- Existing inbound attachment download and content DELETE resources enforce the same policy and ownership.

`FILE_NOT_READY` is retryable after polling; `FILE_UNAVAILABLE` requires inspecting the current owned resource and its
recovery instruction. Foreign resources return 404 on resource APIs. Reprocessing cannot release malicious, integrity-
blocked or purged content. The actual sender rechecks every attachment, current proof and actual bytes before any
provider call; queue-time changes can cause a determinate preparation failure, never a partial provider submission.
Inbound body availability/callbacks do not assert that attachments are already safe. Poll detail for attachment changes;
the inbound change feed records body availability and content erasure, not per-attachment scan completion.
