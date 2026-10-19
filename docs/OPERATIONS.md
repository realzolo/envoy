# Operations Guide

This guide covers the minimal release and recovery procedure for a self-hosted Envoy deployment. It supplements
[deployment instructions](DEPLOYMENT.md); it does not replace provider-specific incident procedures.

## Release Checklist

Before tagging a release:

1. Ensure CI has passed `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` for the intended commit.
2. Review database migrations, environment variable changes, provider behavior, and operator-facing documentation.
3. Back up PostgreSQL and any object storage containing inbound MIME or attachments. Preserve all active KEK versions;
   losing a KEK makes existing encrypted credentials unrecoverable.
4. Create an annotated version tag and GitHub release that names any required upgrade or rollback constraints.

## Deployment validation

Build the image, run the explicit migration task, then start Web and Worker. Check `/api/health`, Worker heartbeat,
and an accepted test delivery. A successful API health check does not imply the Worker is running.

PostgreSQL is the only queue and runtime dependency. Its `bullmq` schema must be backed up with business tables.
Use a direct or session-pooled connection and reserve the documented connection budget before adding replicas.

## Troubleshooting

| Symptom | First checks |
|---|---|
| Health endpoint fails | Check Web container logs, PostgreSQL reachability, business and BullMQ schema readiness, and required environment variables. |
| API rejects a request before message creation | Save `requestId` and query `/api/v1/requests/{requestId}` with the same service credential. Check field errors and sender authorization. |
| Messages remain queued or deferred | Check structured delivery errors and submission attempts, Worker heartbeat/logs, overdue work, the Service-domain binding, its verified outbound provider identity, and provider account health. |
| Provider webhook is rejected | Verify the provider event URL, provider-specific signature material, allowed source configuration, and server clock. For Postmark, use the credential-bearing URL generated when Basic Auth is saved. |
| Resend shows received mail but Inbound is empty | Confirm the Resend webhook subscribes to `email.received`, its Provider Event is verified, the domain selects that Resend account as Inbound provider, and at least one active Service binding has Receive enabled. Check Worker processing errors. Previously processed events can be replayed from Provider Events after configuration only while their verified receipts are retained. |
| Outbound callback delivery fails | Inspect the event callback endpoint URL, signing secret, consumer response, and dead-letter/replay state in the operations console. |
| Credentials cannot be read after deployment | Verify that `ENVOY_KEK_BASE64`, `ENVOY_KEK_VERSION`, and any `ENVOY_KEK_KEYRING_JSON` entries match the keys used to encrypt existing envelopes. |

Use `docker compose logs -f web` and `docker compose logs -f worker` while investigating. Redact credentials,
recipient addresses, message content, and provider-native payloads before sharing logs.

## Recovery

Inspect the specific delivery before retrying it. Unknown results do not automatically fail over: automatic checks stop
after 12 passes, and manual retry requires a duplicate-risk acknowledgement. Suppression and disabled configuration
must be resolved separately. Provider-readiness deferral stops after 60 cycles with a visible failure. Callbacks lists the event ID,
HTTP result, next attempt and error; replay a single dead letter or one endpoint after fixing the consumer.

Provider connection tests are bound to the credential version tested. After rotation, run a new test before enabling
routing. For service keys, issue another key for the same service, switch the caller, then revoke the old key. For
callback secret replacement, pause delivery, drain in-flight requests, update the single secret on both sides, then resume and replay/reconcile.

Dashboard trend uses seven UTC calendar-day delivery cohorts; completed delivery rate is delivered divided by
(delivered + bounced + failed), excluding suppressed/canceled and displaying processing work separately. Future
scheduled Outbox work is normal; only overdue work older than one minute contributes to the backlog warning.

## Content cleanup

Set the desired `ENVOY_RETENTION_*_DAYS` values; unset policies are disabled. Preview with `pnpm data:cleanup`, then
apply with `pnpm data:cleanup --apply` (in Compose: `docker compose run --rm worker pnpm data:cleanup --apply`).
The command processes bounded batches and reports counts. Re-run for further eligible batches. It excludes active or
unknown deliveries and required recovery/callback work, preserves IDs and idempotency summaries, and keeps audit
identity/action/time while optionally clearing old details. Object deletion is retriable; retain object-store backups
according to the same retention policy. Cleared message content and attachment downloads cannot be recovered through
Envoy; inspect the dry-run before applying.

## Mail access operations

Configure these resources in Envoy, not in each business system:

1. **Services**: create a Service per required isolation boundary. Configure domain bindings and the optional Event callback URL in the same form; creation issues the first key. Give the
   caller the Envoy URL and service key; do not share an administrator session or provider credentials.
2. **Provider Accounts / Domains**: associate provider identities and retrieve/present available DNS records.
   The domain administrator publishes them on the actual DNS platform. Refresh the result in Envoy. Provider-specific
   workflows stay with Envoy operators; sending-domain verification is not proof that inbound MX/rules work.
3. **Domains**: assign one inbound provider account per domain and configure its receiving MX/provider rules. An empty
   inbound provider disables receiving for that domain. Domain matching is case normalized and exact; every local part
   belongs to the domain scope. Provider verification for sending does not establish inbound readiness.
4. **Services → Edit configuration**: bind each needed domain. Enable receiving to give that Service a private inbound
   copy, and select one verified outbound provider identity to enable sending. Leave either direction unset to disable
   it. Multiple Services can receive the same domain; each Service chooses its outbound identity independently.
   Saving replaces that Service's bindings and applies to all active keys. Enter the From address and display name
   directly when sending. Removing a binding blocks new submissions and retries even if a caller discovered it earlier.
5. **Capabilities**: review provider readiness and observed evidence for each configured domain. Readiness does not
   reserve provider capacity or guarantee a particular message will be delivered.
6. **Services → Edit configuration**: set the Event callback URL; the signing secret is shown when first configured. **Callbacks** manages subscriptions, secret replacement and delivery recovery.
   Inbound and outbound events use that same endpoint automatically. Give the caller its callback connection
   secret. Callback retries/replay acknowledge transport receipt, never completed business work.

Use `/api/v1/capabilities` with the caller's service key to review `mail`: sender configuration, inbound provider
configuration, canonical send facts, actual inbound observation and callback delivery are separate. `null` evidence and
`unknown` external/runtime states mean unverified; do not relabel them as success. Provider errors/DNS records are
operator diagnostics; callers receive stable reason codes and Envoy request/resource IDs.

In **Provider Accounts → Provider event webhook**, configure verification once per provider webhook endpoint. For Resend,
add Envoy's public HTTPS Provider webhook URL in Resend → Webhooks, select `email.received` and the desired delivery events, then open that webhook's details and
copy its `whsec_...` Signing secret into **Resend webhook signing secret**. See the
[official verification guide](https://resend.com/docs/webhooks/verify-webhooks-requests). The other providers retain their
own public-key, SNS-topic, signing-key or Basic Auth settings. These credentials verify provider → Envoy traffic; the
Event callback signing secret authenticates Envoy → your application. Neither replaces an API key.
For Mailgun inbound routes, use the separate **Inbound route URL (JSON format)** shown in the provider account and
configure Mailgun's JSON route format. Its full-body signature protects the SMTP recipient used for routing; the regular
Provider webhook URL remains for Mailgun event webhooks. The legacy multipart inbound route format is rejected.

Saved verification settings are encrypted and never echoed. Updating requires complete replacement settings; leaving
the form untouched preserves the current configuration. Saving shows configured/waiting, and only an actual verified
event with the current settings produces a valid-event timestamp. A working provider API can submit mail before
webhook verification is configured, but API acceptance alone does not establish recipient delivery.

The Inbound detail drawer distinguishes the Envoy ID, RFC Message-ID, provider-reported recipients, standard reply/thread fields,
and the recipient domains matched for each private Service copy. Inspect the full verified raw provider event when diagnosing
quarantined mail. For Resend, select the Resend account as the domain's **Inbound provider** and enable receiving on each
Service binding that should get a copy. The signed `email.received` webhook supplies recipients; Envoy retrieves the
message body and attachments through the Resend API. Resend's `received_for` comes from a `Received` header; if missing,
Envoy uses the webhook's `to/cc/bcc` fields. Its recipient metadata may differ from the SMTP envelope.

## Authoritative schema

The fresh-project `001_initial.sql` includes the full application schema and both change streams. Rebuild any database
initialized with an earlier prelaunch V1 checksum before running setup for this revision. Future changes append
contiguous versions and checksums. `pnpm db:generate` writes the typed `db/schema.sql` snapshot, and `pnpm db:check`
verifies it and all migration checksums. Setup serializes migrations, validates the recorded catalog, applies missing
versions and records checksums in `envoy_meta.migrations` atomically. A nonempty unjournaled application schema and any
catalog drift are rejected without repair or deletion. BullMQ manages its independent schema. Run setup successfully
before starting the matching Web/Worker build, whose readiness requires current migration checksums.
Observe both `/outbound-changes` and `/inbound-changes`; after a 410 or initial historyTruncated flag, reconcile known
owned resources before adopting the returned reset cursor. A 2xx callback acknowledges durable receipt; downstream
business processing remains the consumer's responsibility.

## Inbound recovery and lifecycle operations

The console distinguishes author Date, trusted Envoy ingress, system storage and readable time. All historical unknowns
stay unknown. Compare each receiving range's notification mode/status with its actual selected callback; polling-only is
valid. Disabled/subscription-mismatched bindings do not look configured. Restore the subscription/endpoint, then replay
only the intended dead letters. HTTP delivery success never changes business conversation status.

The first durable inbound dispatch plan is frozen at normalization. Each private copy has its own claim, attachments and
callbacks; one failed copy does not prevent the others from progressing. An interrupted raw-event job retries only that
plan. Adding Service-domain bindings does not redistribute history. There is no automatic or implicit historical redistribution operation;
any future operator redistribution feature must use a separate audited decision and preserve purge/permission boundaries.

Run `pnpm data:cleanup --apply` regularly for object deletion intents and the 90-day inbound change-prefix cleanup even
when content age policies are unset. Preview remains `pnpm data:cleanup`. Monitor failed deletion intents and consumer
checkpoints; physical bytes can lag a successful content-purge API request. Age policies, explicit content erasure and
recovery termination are different causes, never fake delivery success. Archive/backup/provider-side source retention is
an operator responsibility; a service key never grants shared raw-event or another service's erasure authority.

On callback exhaustion choose **Replay this delivery** after repair, or **Terminate recovery** to irreversibly stop it.
`terminated` retains audit/ID and a separate termination timestamp, leaves delivery evidence unchanged and releases
retention gates. Raw provider events similarly offer termination only after 20 exhausted attempts and no active lease;
unfinished copies become rejected while successful copies remain. Purged or terminated work cannot be replayed. Keep
unknown outbound sends for operator resolution; content deletion cannot bypass them.

For service credential rotation, use **Issue replacement**, deploy its once-shown key, check the new credential ID's
usage time, then revoke the old ID before `overlapUntil`. Callback secrets follow a separate manual procedure:
**Pause** the endpoint, wait for **In flight** to reach zero, use **Generate new secret** and update the consumer with
the once-shown value, then **Resume** and replay endpoint dead letters. Envoy always generates the secret; active endpoints and endpoints with unfinished
attempts reject secret replacement. Recovery closes expired paused attempts; a live HTTP attempt is allowed to finish
and remains visible until then. Reconcile `/inbound-changes` and outgoing status/events after the pause. Retries use their
current Unix timestamp with the original event ID and UTF-8 body. Consumers use a fixed 300-second replay window and
constant-time HMAC-SHA256 verification. Keep clocks synchronized. The `v1=` prefix identifies the signature algorithm;
payload API versions are separate. Envelope `key_version` is private KEK metadata and is never sent to the consumer.

Capability evidence queries remain live configuration reads with indexed historical evidence. Use `EXPLAIN (ANALYZE,
BUFFERS)` on a staging clone at representative volumes before introducing a projection/cache; small test query plans
are not evidence of production latency. This change adds service/provider/time and submission-event evidence indexes,
uses the existing message/service and event/timeline indexes, and adds no authorization/evidence cache. Observe slow
queries and connection budgets. Revocations and runtime authorization never depend on cached evidence.

## Attachment safety operations

See [Attachment Safety](ATTACHMENT-SAFETY.md) for the complete API, queue/fencing contract and Morph/Sonaops cutover checklist.
Envoy alone configures `CLAMAV_HOST`, `CLAMAV_PORT` (default 3310), `CLAMAV_TIMEOUT_MS` (100–30000, default 15000),
`ATTACHMENT_SCAN_CONCURRENCY` (1–16, default 4) and `ATTACHMENT_POLICY_VERSION` (default `1`). The only mode is
`require_clean`: no unscanned bypass exists. Never give scanner addresses/configuration to a business service.

Deploy a private scanner with current signatures and an INSTREAM byte limit of at least 10,000,000 bytes. Start Envoy's
PostgreSQL worker as well as Web; the worker schedules fair scan jobs every second through the existing PostgreSQL
BullMQ/outbox backend. Missing scanners fail closed. **Attachment Safety** shows configuration, current task states,
controlled reasons, attempts, policy and observed-result timestamps; those observations are not a live health guarantee.
Repair temporary failures, then use **Reprocess** (or the service-owned resource endpoint). Malicious/integrity-blocked
resources require removal and a new upload, never ordinary retry. Observe failed outbox jobs too.

Policy/signature changes: stop admission and drain/stop sending workers, update the same policy version/configuration
on all Web/Worker instances, then restart. Do not perform a mixed-policy rolling deployment. A changed version invalidates
prior clean proofs and schedules retained bytes for scanning. Accepted queued sends whose attachments are no longer
approved fail before provider submission; after files become usable, retry only eligible determinate failures with the
existing message retry API. Unknown/accepted/canceled submissions are not automatically replayed. No historical file is
backfilled clean; no upgrade/adoption or historical resend path is provided.

Run the existing cleanup task for unreferenced uploads, quarantined files and deletion intents. Purge triggers revoke
safety and fence late jobs atomically. A download already authorized and copied before erasure may finish; deletion
cannot recall bytes already delivered to a caller. Backups, object-store administrators and business caches retain their
own lifecycle responsibilities. This task has performed no production deployment, scanner setup, migration or real send.


## Sensitive-mail privacy and deadlines

Keep the worker running: its mandatory 10-second privacy sweep destroys expired sensitive message envelopes independently of optional day-based retention, and retries durable object-deletion intents. Monitor worker heartbeats and storage cleanup failures; outages delay physical deletion but cannot enable preview or a new submission after `sendBefore`. Keep previous KEKs in `ENVOY_KEK_KEYRING_JSON` while versioned sensitive idempotency digests still need verification. Losing these keys prevents safe same-key comparisons even after body cleanup.

Sensitive messages show a fixed placeholder in email lists and an unavailable-content explanation in the detail panel. Diagnose using message/reference/request IDs, delivery lifecycle, accepted/delivered timestamps and fixed diagnostics. Do not copy real verification codes into identifiers, category, reusable attachments, provider account labels or operator notes. Provider raw data is encrypted; outbound raw copies disappear after normalization or 15 minutes pending. A whitelist of normalized outbound facts is durably frozen first, so late association and replay still work after raw expiry; replay never reconstructs the original body. Unknown classifications and inbound receipts keep their independent recovery lifecycle. Accepted/unknown work retains its facts and is never automatically failed/resubmitted due to a content deadline. Templates, verification-code validation and TTL belong to the caller.
