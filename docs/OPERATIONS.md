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
| Messages remain queued or deferred | Check Worker heartbeat/logs, overdue work, active routing targets, verified provider identities, quotas, and provider account health. |
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
