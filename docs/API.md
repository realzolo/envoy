# Service API contract

Envoy exposes one native-mail service API at `/api/v1`. `GET /api/v1` lists resources;
`GET /api/v1/openapi.json` is the machine-readable schema. Provider selection and credentials stay internal.

## Authentication and authorization

Use `Authorization: Bearer <service-key>`. Each key belongs to one service and product. Resource ownership is checked
on every request, including files, events, and request diagnostics; another service's identifiers are not accessible.
`GET /capabilities` returns current limits, supported mail features, and sender authorizations.

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
