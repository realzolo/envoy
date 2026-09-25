# Release And Operations Guide

This guide covers the minimal release and recovery procedure for a self-hosted Envoy deployment. It supplements
[deployment instructions](DEPLOYMENT.md); it does not replace provider-specific incident procedures.

## Release Checklist

Before tagging a release:

1. Ensure CI has passed `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` for the intended commit.
2. Review database migrations, environment variable changes, provider behavior, and operator-facing documentation.
3. Back up PostgreSQL and any object storage containing inbound MIME or attachments. Preserve all active KEK versions;
   losing a KEK makes existing encrypted credentials unrecoverable.
4. Create an annotated version tag and GitHub release that names any required upgrade or rollback constraints.

## Upgrade

Read the target release notes first. On the deployment host, use the production procedure from
[DEPLOYMENT.md](DEPLOYMENT.md): update the checkout, rebuild the image, run `docker compose run --rm migrate`, then
start the Web and Worker services.

The current baseline-schema release is an exception: it requires a fresh, empty database and has no in-place upgrade
path from earlier Envoy schemas. Follow the fresh deployment procedure instead of this upgrade procedure.

Validate the upgrade by checking `docker compose ps`, `GET /api/health`, and both Web and Worker logs. Database
migrations are forward-only. Do not roll back application code after a schema migration unless the earlier version is
known to work with the migrated schema. Restore a pre-upgrade backup instead when that compatibility is uncertain.

## Troubleshooting

| Symptom | First checks |
|---|---|
| Health endpoint fails | Check Web container logs, PostgreSQL reachability, Redis reachability, and required environment variables. |
| Messages remain queued or deferred | Check Worker logs, Redis, active routing targets, verified provider identities, quotas, and provider account health. |
| Provider webhook is rejected | Verify the provider event URL, provider-specific signature material, allowed source configuration, and server clock. For Postmark, use the credential-bearing URL generated when Basic Auth is saved. |
| Outbound callback delivery fails | Inspect the business callback endpoint URL, signing secret, consumer response, and dead-letter/replay state in the operations console. |
| Credentials cannot be read after deployment | Verify that `ENVOY_KEK_BASE64`, `ENVOY_KEK_VERSION`, and any `ENVOY_KEK_KEYRING_JSON` entries match the keys used to encrypt existing envelopes. |

Use `docker compose logs -f web` and `docker compose logs -f worker` while investigating. Redact credentials,
recipient addresses, message content, and provider-native payloads before sharing logs.
