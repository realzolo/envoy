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
| Messages remain queued or deferred | Check structured delivery errors and submission attempts, Worker heartbeat/logs, overdue work, sender grants, active routing targets, verified provider identities, quotas, and provider account health. |
| Provider webhook is rejected | Verify the provider event URL, provider-specific signature material, allowed source configuration, and server clock. For Postmark, use the credential-bearing URL generated when Basic Auth is saved. |
| Outbound callback delivery fails | Inspect the business callback endpoint URL, signing secret, consumer response, and dead-letter/replay state in the operations console. |
| Credentials cannot be read after deployment | Verify that `ENVOY_KEK_BASE64`, `ENVOY_KEK_VERSION`, and any `ENVOY_KEK_KEYRING_JSON` entries match the keys used to encrypt existing envelopes. |

Use `docker compose logs -f web` and `docker compose logs -f worker` while investigating. Redact credentials,
recipient addresses, message content, and provider-native payloads before sharing logs.

## Recovery

Inspect the specific delivery before retrying it. Unknown results do not automatically fail over: automatic checks stop
after 12 passes, and manual retry requires a duplicate-risk acknowledgement. Suppression and disabled configuration
must be resolved separately. Route deferral stops after 60 cycles with a visible failure. Callbacks lists the event ID,
HTTP result, next attempt and error; replay a single dead letter or one endpoint after fixing the consumer.

Provider connection tests are bound to the credential version tested. After rotation, run a new test before enabling
routing. For service keys, issue another key for the same service, switch the caller, then revoke the old key. For
callback signing rotation, deploy consumer verification for the new secret before switching the endpoint secret.

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

1. **Service Credentials**: create a product/service per required isolation boundary and issue its limited key. Give the
   caller the Envoy URL and service key; do not share an administrator session or provider credentials.
2. **Provider Accounts / Domains**: associate provider identities and retrieve/present available DNS records.
   The domain administrator publishes them on the actual DNS platform. Refresh the result in Envoy. Provider-specific
   workflows stay with Envoy operators; sending-domain verification is not proof that inbound MX/rules work.
3. **Senders**: grant a domain range or exact local part to a product/service. Optional sender presets publish a suggested
   From name and simplify console composition; they are not mandatory business API identities. Revocation blocks new
   submissions and retries even if a caller discovered the grant earlier.
4. **Routing**: configure outbound policies and categories. Discovery reports configured categories, not a reserved quota
   or a guarantee for a particular content/recipient set.
5. **Domains / Inbound**: register an inbound-only domain with no outbound providers selected, then route the receiving domain and route its exact address or local-part pattern to a service. An active
   registered domain and secured supported ingress suffice for an Envoy route; no outbound sender grant or verified
   outbound provider identity is required. Configure receiving MX/provider rules here through the operator workflow.
   Exact matching is case normalized, `*` is the only wildcard, and plus aliases need an explicit matching pattern.
   Routes without a service stay administrator-only. Identical patterns on different services intentionally distribute
   private copies to all of them; review that choice as a receiving-data authorization.
6. **Callbacks**: configure the business HTTPS URL, subscriptions and signature secret. Select a callback for inbound
   routes; outbound delivery events use the service's subscribed endpoints. Give the caller its callback connection
   secret. Callback retries/replay acknowledge transport receipt, never completed business work.

Use `/api/v1/capabilities` with the caller's service key to review `mail`: sender configuration, inbound route
configuration, canonical send facts, actual inbound observation and callback delivery are separate. `null` evidence and
`unknown` external/runtime states mean unverified; do not relabel them as success. Provider errors/DNS records are
operator diagnostics; callers receive stable reason codes and Envoy request/resource IDs.

The Inbound detail drawer distinguishes the Envoy ID, RFC Message-ID, SMTP recipients, standard reply/thread fields,
and the representative route for each merged service copy. Inspect the full verified raw provider event when diagnosing
quarantined mail. `ENVELOPE_RECIPIENT_UNAVAILABLE` requires a trusted provider recipient source, not adding guessed
headers or widening patterns. Resend inbound currently remains quarantined because the reviewed retrieval contract
does not explicitly establish an envelope-recipient source. Configure a supported alternative ingress inside Envoy
before enabling business receipt; this does not change Resend outbound support.

Schema adoption: this pre-release repository keeps `001_initial.sql` authoritative, as required by CONTRIBUTING. It now
adds `delivery_scope`, `envelope_recipients`, `reply_to`, `in_reply_to`, `references_ids`, replaces inbound message
uniqueness with `(provider_account_id, external_message_id, delivery_scope)`, and makes route uniqueness include the
receiving service/product scope. New installations/tests apply the final schema normally. No migration command in this
change has been run against a development/production business database.

For a data-bearing older installation, stop workers during a separately reviewed schema adoption. Back up first, add
these columns/indexes and replace the old uniqueness constraints before starting this version. Do not reconstruct
trusted envelopes from old `to_emails`: legacy rows require administrator review/quarantine until their original verified
receipt establishes ownership. Pending legacy callbacks also require review before replay. Retain external transport IDs,
copy IDs and historical deduplication evidence, and do not automatically redistribute historical mail to newly added routes.
The standard migration runner deliberately refuses an edited already-applied initial checksum; deployment owners must
reconcile the reviewed final schema baseline rather than deleting migration history or resetting a live database.
Business consumers only need the additive API/callback adoption described in [API.md](API.md#adopting-the-business-connection-contract).
