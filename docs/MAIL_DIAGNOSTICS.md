# Canonical mail diagnostics and observation ownership

Envoy owns transport observations, provider adaptation, recipient protection and its own submission/reconciliation workflow. Callers own business execution status, expiration, credentials and decisions to start a new business send. Administrative UI only presents authorized observations and explicitly authorized actions. A diagnostic query never unblocks a recipient or authorizes another submission.

## One diagnostic and one complete delivery snapshot

`src/contracts/mail-diagnostics.ts` is the finite typed authority. Exported machine schemas live in `docs/contracts/mail-diagnostic.schema.json` and `delivery-snapshot.schema.json`. Public and administrative reads use the same diagnostic and delivery projection. There is no `lastError`, free-text diagnostic message, native provider error string or second error column.

`MailDiagnostic` has `source`, coarse `code`, nullable specific `reasonCode`, `stage`, `detailAvailability`, structured `evidence` and nullable `occurredAt`. Codes describe categories such as a permanent recipient rejection or a submission failure. Reasons describe independently proven facts such as `MAILBOX_NOT_FOUND` or `PROVIDER_QUOTA_EXCEEDED`. A hard bounce alone never proves that a mailbox does not exist. `SPECIFIC` requires a known reason; absent provider detail and absent historical detail are explicitly distinguished. Historical occurrence time remains null when not recorded; local observation/update time is not substituted.

Evidence is a strict whitelist: validated standard `smtpReplyCode`, enhanced `smtpStatus`, `bounceClass` (`HARD`, `SOFT`, `UNKNOWN`) and a finite `suppressionReason`. Unknown bounce types remain `UNKNOWN` and do not increment the soft-bounce threshold. Provider subtype and standard SMTP facts are extracted before content-free replay and again survive canonical sensitive-event normalization. No raw SMTP prose, provider reason string, message body or verification code crosses these boundaries. Conflicting specific reasons are omitted rather than guessed.

Resend uses the official bounce `subType`, `diagnosticCode` array and `message` only as extraction inputs. A bounded parser retains valid standard codes, while a finite adapter mapping interprets known subtype and machine codes, including asynchronous `failed.reason=reached_daily_quota`. Original text is discarded. `NoEmail`, an unknown subtype and an unqualified SMTP reply such as 550 do not establish mailbox nonexistence. Provider submission errors retain only known reason codes and the fixed coarse error category.

`RetryDisposition` describes responsibility, independently of diagnostic cause and action authorization:

| Owner | Action | Meaning |
| --- | --- | --- |
| `ENVOY` | `SCHEDULED` | Envoy has further workflow work; optional next time is a fact when known. |
| `ENVOY` | `MANUAL_REVIEW` | Envoy workflow exhausted; operator review is needed. |
| `PROVIDER` | `WAITING_PROVIDER` | Provider accepted responsibility and final delivery remains pending. |
| `NONE` | `STOPPED` | This delivery processing has ended. |
| `UNKNOWN` | `MANUAL_REVIEW` | Original submission outcome cannot be resolved automatically. |

Provider-managed deferral does not permit manual resend. `sendBefore` prevents new provider submissions; it cannot revoke a provider's accepted queue. Accepted or uncertain submissions retain facts and continue receipt/reconciliation processing after the caller's deadline.

The complete flat snapshot is `{id,messageId,revision,submissionId,attemptId,lifecycle,outcome,acceptedAt,deliveredAt,diagnostic,retryDisposition,observedAt}`. `revision` is a decimal bigint string scoped to the delivery. Its database trigger advances when current identity, lifecycle, compliance, engagement, diagnostic, retry disposition or acceptance/delivery facts change; no-op writes do not advance it. New current submissions/attempts clear old current-attempt timing and diagnostics. Message+delivery snapshots are selected in one SQL statement. Administrative queue acceptance never substitutes for provider acceptance. `observedAt` is read time and must be excluded from equality/hash comparisons of equal revisions.

## Administrative presentation

Envoy administrative interface text is English, including diagnostic explanations, suppression reasons and next steps. Callers localize the canonical codes for their own audiences; display language is not part of the diagnostic wire contract. Message subjects and other original business content retain their original language.

The shared delivery presentation distinguishes ordinary progress, successful completion, unknown outcomes and failures. An absent diagnostic does not imply a failure or a missing failure record: delivered messages show successful delivery with no action needed, while queued, submitting, accepted and deferred messages describe their current progress. Only failed or bounced deliveries with no diagnostic report missing failure details. `NONE` / `STOPPED` describes completed processing, so successful deliveries must not present it as a stopped or failed operation. List and detail views share these presentation rules.

## Pre-acceptance submission rejection

All RFC 9457 Problem responses include explicit nullable `diagnostic`; the formal envelope schema is `docs/contracts/submission-problem.schema.json`. A rejected `POST /api/v1/messages` has no message/delivery resource, so callers persist this safe diagnostic as an execution result and retain the request ID. The authenticated request log stores the same diagnostic; `GET /api/v2/requests/{requestId}` returns it. Historical generic validation records retain `VALIDATION_FAILED` with `NOT_RECORDED` and no inferred specific reason.

Schema validation classifies an invalid recipient only from typed Zod `invalid_format` / `format=email` issues at exactly `to|cc|bcc`, nonnegative integer index, `email`. This produces `INVALID_RECIPIENT` / reason `INVALID_RECIPIENT`, source `ENVOY`, stage `PREPARATION`. Other validation produces coarse `VALIDATION_FAILED`, null reason and `CATEGORY_ONLY`. Sender/reply address validation, non-string values, duplicates and unrelated fields never become guessed recipient-format errors. Issue messages, input values and request content are never diagnostic evidence. HTTP Problem `code` keeps its validation category and canonical `diagnostic` supplies the proven reason; neither grants a retry or changes acceptance semantics.

## Versioned reads and stable change signals

Diagnostic read routes are exclusively:

- `GET /api/v2/messages/{id}`
- `GET /api/v2/messages/{id}/attempts`
- `GET /api/v2/messages/{id}/events`
- `GET /api/v2/deliveries`
- `GET /api/v2/deliveries/{id}`
- `GET /api/v2/events`
- `GET /api/v2/requests/{requestId}`

The message response has `deliveries:[{...snapshot,recipient,recipientName,recipientRole,engagement,compliance}]`. Recipient identity stays outside a caller's persisted transport observation. Attempts are a paginated typed history including `id`, `submissionId`, `number`, finite `status`, `outcomeDeterminate`, canonical `diagnostic`, RFC Message-ID confirmation, timestamps and recipient associations. Native provider IDs and raw responses are not public.

The former v1 diagnostic reads are retired without aliases. v1 submissions, explicit retry/cancel operations, capabilities, attachments, inbound APIs, callback signing and outbound change feed retain their authority and semantics. Callbacks/feed are change signals; consumers fetch current v2 snapshots and fence observations using delivery revision and current submission/attempt identity. The single OpenAPI catalog remains `/api/v1/openapi.json`; diagnostic read operations explicitly select the `/api/v2` server.

## Migration and verification

Forward migration 005 transforms already stored categories deterministically, marks historical detail `NOT_RECORDED`, removes old free-text diagnostic columns and adds revision/validated retry state. It does not infer missing SMTP details or perform a provider lookup. No automatic production historical refill exists. Executed migrations 001–004 remain immutable. Typed schema, SQL snapshot, checksums and strict database JSON validation must move together.

Use `TEST_DATABASE_ADMIN_URL` for unique disposable test databases. Full verification covers populated V4 conversion, failed-upgrade rollback, repeated initialization, catalog/checksum drift, JSON-null rejection, revision no-op behavior, official bounce arrays, unknown classification and sensitive-event privacy. Run root `CLAUDE.md` checks with isolated PostgreSQL; never use deployment data as test fixtures.
