# Service API contract

Envoy exposes one native-mail service API at `/api/v1`. `GET /api/v1` lists resources;
`GET /api/v1/openapi.json` is the machine-readable schema. Provider selection and credentials stay internal.

## Authentication and authorization

Use `Authorization: Bearer <service-key>`. Each key belongs to one service and product. Resource ownership is checked
on every request, including files, events, and request diagnostics; another service's identifiers are not accessible.
`GET /capabilities` returns product/service identity, current limits, native mail features, explicit sender/receiver scopes, configuration status and observed evidence. See the business connection contract below.

An administrator grants the product or service an active domain or exact sender address under **Senders**. Verification
of a domain on a provider is a separate prerequisite. A caller may directly specify any authorized From address and name.
No sender profile is required or accepted by the service API. Optional console presets fill normal request fields only.

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
| `from` | Required `{email,name?}`; address must match a current sender grant |
| `to`, `cc`, `bcc` | Arrays of `{email,name?}`, default empty; 1–50 recipients combined, unique across roles |
| `replyTo` | Array of `{email,name?}`, default empty, at most 10 addresses |
| `subject` | Header-safe string, defaults to empty, at most 998 characters |
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

The `201` result contains `id`, filename, media type, byte size, SHA-256, availability, and creation time. Reference that
`id` as `fileId` in a send request. A file belongs to the uploading service; expired or inaccessible files cannot be sent.
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
| `GET /events` | Cursor-paginated canonical events |
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
submission-scoped rather than inventing recipient attribution. Verify HMAC-SHA256 over `timestamp + "." + body`, reject
stale timestamps, and deduplicate `x-envoy-id`. Configure callback URLs and signing secrets through administrator settings.

## Retention and time

API timestamps use UTC ISO 8601. The console formats them in the browser timezone. Message bodies, attachment bytes,
request diagnostics, and audit details have separately configured retention. Active or unknown mail is protected from
content cleanup; identifiers, state, errors, and idempotency summaries remain useful after body removal. Check
`contentAvailable` and content-purge fields before depending on stored content.

## Business mail connection and discovery

Business configuration consists of the Envoy base URL, one service key, the chosen authorized From/receiving address(es),
and the callback connection (HTTPS URL and signing secret issued by Envoy). Business services never need administrator
credentials, provider accounts, DNS records, domain verification APIs, or a sender profile ID. Each APP can bind its own
service key; APP identity, mailbox purposes, conversations, assignees and ticket links belong to the caller.

`GET /capabilities` still returns `product`, `service`, limits and native features. Its new `mail` object is the
provider-neutral integration contract. These are address permissions, **not IMAP/SMTP login accounts** (`mailboxLogin:false`).
All entries and evidence are scoped to this credential's service; product sender grants apply to each service, but
never grant access to another service's mail or inbound routes.

| Field | Meaning |
|---|---|
| `mail.senders[].kind` | `exact_address` has a complete `address`; `domain` has `address:null` and authorizes From addresses only on that exact `domain`, not subdomains |
| `scope`, `authorization` | Grant applies to `product` or `service`; current state is `granted` or `revoked`. Disabled grants remain discoverable here for diagnosis |
| `displayName` | Optional public From display name from an existing active exact-address console preset; `null` when none exists. It is a suggestion, not a required profile |
| `sending.state` | `configured` means an active grant/domain and a currently configured eligible target with a verified identity and usable credential exist; otherwise `unavailable` |
| `sending.categories` | Categories with an eligible configured target; a `null` entry means the policy has no category restriction |
| `sending.runtimeAvailability` | Always `unknown`: discovery does not reserve capacity, evaluate the eventual content, guarantee provider availability, or override live authorization checks |
| `evidence.lastAcceptedAt` / `lastDeliveredAt` | Latest actual canonical acceptance/delivery fact for this service and sender range, or `null` (unverified). Includes recipient and submission facts; a submission delivery fact does not prove every recipient succeeded |
| `mail.receivers[].kind` | `exact_address` has a complete `address`; `local_part_pattern` has `address:null`, an exact `domain`, and `localPartPattern`. `*` matches zero or more local-part characters; no implicit plus-address expansion |
| `receiving.state` | `configured` means an active Envoy route/domain and secured active ingress with a supported envelope-recipient contract; otherwise `unavailable`. It says nothing about MX or external provider receiving setup |
| `receiving.externalReadiness` | `unknown`: domain verification never establishes inbound reachability. A pattern describes configured routing, not an enumeration of real mailboxes |
| `evidence.lastReceivedAt` | Envoy database observation time of the latest ready inbound copy for this service matching that route, or `null` (unverified). Does not use the sender-controlled Date header; historical evidence does not guarantee future receipt |
| `mail.callbacks.configuration` | `configured` if this service has an active callback endpoint, else `unavailable`; subscriptions and per-route callback choices still determine which events are delivered |
| `mail.callbacks.latest` | Most recently created callback delivery's `status`, `attemptCount`, `deliveredAt`; `null` when none exists. Pending with zero attempts is not successful delivery |
| `mail.callbacks.lastDeliveredAt` | Latest successful callback HTTP delivery across this service's endpoints, or `null`. Historical success does not establish that another endpoint/event works |
| `mail.callbacks.businessProcessing` | Always `unknown`; an HTTP 2xx acknowledges receipt, not a completed conversation or business transaction |

`reasonCodes` are stable machine values; callers should handle unknown future codes with a generic operator-action message:

| Code | Business action |
|---|---|
| `SENDER_NOT_AUTHORIZED` | Stop using that From address; ask the Envoy operator to review the grant |
| `SENDING_DOMAIN_DISABLED` | Ask the Envoy operator to restore sending infrastructure |
| `NO_ELIGIBLE_ROUTE` | Ask the Envoy operator to configure a usable outbound route/category |
| `INBOUND_ROUTE_DISABLED` | Choose another configured receiving address or ask the operator |
| `INBOUND_DOMAIN_DISABLED` | Ask the operator to review the inbound domain |
| `INBOUND_INGRESS_UNAVAILABLE` | Ask the operator to restore secured provider ingress |
| `ENVELOPE_RECIPIENT_UNAVAILABLE` | Ownership cannot be established safely; the operator must use an ingress with a documented trusted envelope contract |

DNS records, credential failures and provider setup details remain in Envoy's administrator console. The sender grant
and From/domain/product state are rechecked during acceptance, submission and retry. A prior `configured` response
cannot bypass revocation. The send API continues to return problem codes such as `SENDER_NOT_AUTHORIZED` and
`NO_ELIGIBLE_ROUTE`, with a service-owned `requestId`. An idempotent replay returns the original durable acceptance
receipt; it does not send again or bypass the worker's current checks.

## Inbound ownership, standard fields and callbacks

Routing uses provider-authenticated SMTP recipients, never visible To/Cc/Bcc, `Delivered-To`, `X-Original-To`, arbitrary
MIME headers, or a provider's outbound domain verification status. A matching sender grant does not confer receiving
permission. Routes without a service are administrator-only; they are not inherited by every service in the product.

Every matching route participates. Identical exact patterns can explicitly target different services. Overlapping
routes for the same service merge into one copy with the union of matched envelope addresses; each distinct active
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
mail through `/inbound-messages` pagination and signed inbound callbacks. Use the RFC fields to construct a standard
reply (`inReplyTo` and `references`); conversation matching and ticket state remain business rules. Missing outbound
RFC Message-ID is not fabricated from Envoy/provider IDs; use inbound RFC threading fields when available.

Missing/invalid trusted envelopes are quarantined as administrator-only rejected records with
`ENVELOPE_RECIPIENT_UNAVAILABLE`; no matching active route yields `NO_INBOUND_ROUTE`. No service callback is emitted.
Terminal content rejection reasons are stable codes: `INBOUND_MESSAGE_TOO_LARGE`, `INBOUND_ATTACHMENT_TOO_LARGE`,
`INBOUND_MALWARE_DETECTED`. Transient storage/scanner failures remain retryable, rather than becoming a false rejection.

Provider contracts and current adapter behavior are documented in [Architecture](ARCHITECTURE.md#inbound-safety).
In particular, Resend's current adapter deliberately quarantines incoming messages because the retrieved contract does
not unambiguously identify SMTP recipients. Its outbound sending support is unchanged.

## Adopting the business connection contract

Sending requests and service credentials are unchanged. Capabilities, inbound detail and inbound callback changes are
additive. Existing `senderGrants` is retained as a legacy active-grant view; new integrations use `mail` for explicit
ranges and status. `providerCapabilities` is retained but deprecated in OpenAPI; business logic should stop depending
on its provider names. Strict response/callback decoders need to allow the new fields or regenerate from OpenAPI.

Consumers must switch ownership assumptions from visible `to` to `envelopeRecipients`, handle multiple private inbound
IDs across services, and treat missing RFC fields and evidence as unknown. Do not implement domain/DNS screens, cache
capabilities as permanent authorization, or assume send authorization grants inbound access. Existing Resend inbound
consumers must arrange a supported trusted ingress in Envoy before relying on delivery. Historical mail whose ownership
was previously guessed is not automatically redistributed or relabeled as verified; operators must review it separately.

The final initial schema now stores per-service inbound copies and RFC fields; see the schema adoption notes in
[Operations](OPERATIONS.md#mail-access-operations). No production data or external configuration is changed by this patch.

A runnable minimal connection example is [examples/service-mail.mjs](../examples/service-mail.mjs):

```bash
export ENVOY_URL=https://envoy.internal.example
export ENVOY_SERVICE_KEY='<service-scoped key issued by Envoy>'
export ENVOY_MAILBOX=support@brand.example
export ENVOY_CALLBACK_SECRET='<callback connection secret issued by Envoy>'
node examples/service-mail.mjs discover
node examples/service-mail.mjs send order-123 customer@example.net
node examples/service-mail.mjs inbound
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
