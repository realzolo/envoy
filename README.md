# Envoy

Envoy is a provider-neutral email control plane and delivery data plane for internal services. Business
services submit native From, To, Cc, Bcc, Reply-To, subject, final HTML/plain text, headers, and attachments. Envoy enforces sender authorization and owns provider
routing, credentials, delivery state, inbound mail, suppressions, and canonical callbacks. Business content definitions,
localization, and rendering remain in the calling service.

## Architecture

- Next.js serves the internal Message API, provider event ingress, authentication, and the operations console.
- A separate TypeScript worker runs delivery, event normalization, inbound processing, callbacks, reconciliation, and
  transactional outbox dispatch.
- Business modules use application services, pure domain rules and semantic repository ports. HTTP controllers and
  workers call module public interfaces; SQL and driver details stay in repository implementations.
- PostgreSQL stores business state, BullMQ jobs (in its own schema), shared rate limits, and worker heartbeats.
  Drizzle defines all application tables and provides the typed database client; complex parameterized SQL stays in repositories.
- Provider credentials are stored as envelope-encrypted database records. Every secret has an independent AES-256-GCM
  data key wrapped by the configured root KEK.
- Envoy never stores or renders business content definitions. Persisted content is the immutable send payload needed for
  delivery, support, and callbacks.
- One delivery tracks each recipient and its To/Cc/Bcc role. Submissions preserve complete visible mail headers
  while controlling the actual envelope recipients; every provider call creates an immutable submission attempt.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the domain model, failure semantics, provider setup, inbound
pipeline, and security model.

## Project Documentation

- [Deployment guide](docs/DEPLOYMENT.md)
- [Release and operations guide](docs/OPERATIONS.md)
- [Business mail connection contract and runnable example](docs/API.md#business-mail-connection-and-discovery)
- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Local setup

Requirements: Node.js 22+, pnpm, and PostgreSQL 14+ configured in `.env.local`.

Create `.env.local` from `.env.example` and set an explicit administrator email, password, session secret, and KEK before
starting the application.

Run `pnpm db:setup` against the target PostgreSQL database before starting Web or Worker. Setup initializes an empty
database or applies missing ordered migrations to an existing supported schema, then invokes BullMQ's official
PostgreSQL initializer. Application migrations run under one advisory transaction lock with checksum and complete
catalog verification. Re-running setup validates without replaying SQL; schema drift is rejected without repair or
business-data removal. A deployed V1 is recognized by its exact catalog and upgraded through V2 with its data retained.

```bash
pnpm install
pnpm db:setup
pnpm dev:all
```

Open [http://localhost:6178](http://localhost:6178) and sign in with the `ENVOY_ADMIN_EMAIL` and
`ENVOY_ADMIN_PASSWORD` values from `.env.local`.

The database starts with no services, domains, providers, messages, or inbound mail. Create the first service
under **Services**, then configure real provider accounts and their write-only credentials under **Provider
Accounts**. No provider key belongs in an environment file.

The web process and worker are intentionally separate. The production Compose file runs them as independently
restartable containers from one image. Both require PostgreSQL; only the worker performs provider sends,
event application, callbacks, and reconciliation.

## Message API

```bash
curl --request POST http://localhost:6178/api/v1/messages \
  --header "Authorization: Bearer $ENVOY_SERVICE_KEY" \
  --header 'Idempotency-Key: login-attempt-456' \
  --header 'Content-Type: application/json' \
  --data '{
    "from": { "email": "security@mail.company.com", "name": "Account Security" },
    "category": "security",
    "to": [{ "email": "recipient@company.com", "name": "Recipient" }],
    "subject": "482901 is your login code",
    "html": "<p>Hello, your login code is <strong>482901</strong>.</p>",
    "text": "Your login code is 482901.",
    "tags": { "purpose": "login" },
    "referenceId": "login_attempt_456",
    "metadata": { "environment": "development" }
  }'
```

The API returns `202 Accepted` after the message, recipient deliveries, and outbox records commit in one PostgreSQL
transaction. The request contract rejects provider names, provider accounts, scheduling options, and other
provider-specific fields.

The service API is self-describing at `GET /api/v1` and `GET /api/v1/openapi.json`. Authenticated resources include:

| Resource                | Operations                                                                       |
|-------------------------|----------------------------------------------------------------------------------|
| `/messages`             | Queue and list messages                                                          |
| `/messages/{id}`        | Inspect normal content or redacted sensitive metadata and recipient deliveries                                   |
| `/messages/{id}/cancel` | Cancel deliveries that have not crossed the provider boundary                    |
| `/messages/{id}/retry`  | Retry eligible outcomes with duplicate-risk acknowledgement for unknown outcomes |
| `/deliveries`           | List recipient-level deliveries and inspect attempts                             |
| `/events`               | Read normalized delivery events                                                  |
| `/inbound-changes` | Recover service-scoped inbound availability and content-purge events with a durable cursor |
| `/{messages,inbound-messages,files}/{id}/content` | Idempotently clear owned content subject to active/shared-work guards |
| `/inbound-messages`     | List and inspect sanitized inbound mail; download eligible private attachments     |
| `/suppressions`         | Check, create, and remove service-owned suppressions                             |
| `/requests/{requestId}` | Query request outcomes, including validation and authorization failures before message creation |
| `/files` | Receive private files, query asynchronous safety, retry recoverable processing and download approved bytes |
| `/messages/{id}/events` | Inspect the complete delivery timeline |
| `/messages/{id}/attempts` | Inspect submission attempts and structured diagnostics |
| `/capabilities`         | Discover service, domain sending/receiving permissions, limits, configuration status and evidence                            |

Create a Service under **Services** with its sending/receiving permissions, optional Event callback URL, and advanced permissions. Creation issues the first API key; **Edit configuration** changes the same configuration for every key of that Service. **Manage credentials** handles key issuance, replacement, and revocation. A Service can use several domains; keys rotate without changing its identity or grants. Envoy does not configure business APPs or their mailbox purposes. The caller selects its complete From/Reply-To addresses within authorized domains and performs internal APP routing from trustworthy envelope recipients.

For sending and receiving independently, choose **All domains (current and future)** to automatically authorize newly registered domains. Each direction has three exclusive modes: no permission, selected domains, or All domains. Edit the Service configuration to change modes; saving replaces previous permissions atomically. Domain activation and mail routing still apply.

See [the final service API contract](docs/API.md) for full request fields, file upload, result semantics, and failure diagnosis.

Query status with the same service credential:

```bash
curl http://localhost:6178/api/v1/messages/msg_example \
  --header "Authorization: Bearer $ENVOY_SERVICE_KEY"
```

## Provider event ingress

Each provider account receives an opaque endpoint:

```text
POST /api/provider-events/{provider}/{opaqueEndpointId}
```

Configure this provider event URL and its verification material under **Provider Accounts**. The **Callbacks** page is
reserved for outbound canonical callbacks to business services.

The HTTP path verifies the provider signature and replay window, stores the immutable raw event plus an outbox record in
one transaction, and returns immediately. Workers normalize and apply canonical events asynchronously.

Open **Inbound** to inspect sanitized messages received through configured provider accounts, **Callbacks** to monitor
signed event callback delivery, and **Audit Log** to review administrator actions.

## Production deployment

Production deployment builds the Docker image from a server-side Git checkout and runs separate Web and Worker
containers with Docker Compose. The application binds to loopback port `6178`; an HTTPS reverse proxy on the same host
publishes it. Copy `docker-compose.example.yml` to the Git-ignored `docker-compose.yml` and the shared `.env.example` to
`.env.production` before deployment. Configure a database reachable from the containers and switch object storage to
`s3` with your R2 settings. PostgreSQL, R2, and secrets are provided through `.env.production`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) or the
[Chinese guide](docs/DEPLOYMENT.zh-CN.md).

## Commands

```bash
pnpm db:check           # verify current schema snapshot and immutable migration checksums
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm worker
pnpm data:cleanup        # dry-run; configure retention days first
pnpm data:cleanup --apply
```

All provider credentials, webhook secrets, and callback signing secrets live in encrypted database envelopes. The
environment contains root infrastructure trust only: database, the KEK, admin authentication, object storage,
scanner connectivity, and worker tuning.

## Delivery guarantees and limits

`202` is a durable acceptance receipt, including on idempotent replay; query the resource for its current status.
A service-scoped key with identical content returns the same receipt and timestamp. Different content returns `409`.
Message IDs and idempotency summaries are retained after optional content cleanup. All authenticated v1 requests share
the advertised fixed-minute rate limit and return request IDs and rate-limit headers; errors use problem details.

A live submission has a deadline. Duplicate work does not interrupt it; ambiguous outcomes stay unknown and never
fail over automatically. Manual retry records explicit risk authorization without rewriting the original uncertainty,
and cannot bypass current suppression or revoked sender-authorization or suspended service or disabled domain checks. Deferred routing stops after 60
cycles; reconciliation stops after 12 checks and leaves unknown outcomes for operator review.

The console searches the full delivery history with URL filters and cursor pagination. CSV applies the same filters
and exports at most 10,000 rows. Delivery details show accepted sender/content snapshots; Callbacks offers scoped replay
and delivery diagnostics; Inbound provides private downloads only for ready messages that satisfy the scanning policy.

Server processes and database sessions use UTC; API timestamps are UTC ISO 8601 (`Z`). The console formats timestamps in the current browser timezone and labels that zone. Cohort/rate/quota windows are UTC and labeled explicitly.

Each Service callback has one current encrypted secret. Consumers verify HMAC-SHA256 over the current Unix timestamp,
a dot and the original UTF-8 body within a fixed 300-second window, then durably deduplicate the event ID. Replace the
secret only by pausing delivery, waiting for in-flight requests to finish, updating both sides and resuming; replay and
incremental recovery remain available. See [callback operations](docs/OPERATIONS.md).

Application SQL migrations under `db/migrations/` are immutable once executed. `001_initial.sql` remains unchanged;
`002_outbound_changes.sql` adds and backfills the Service outbound recovery stream. Maintain their ordered SHA-256
entries in `db/migrations/checksums.json`. Change typed definitions or native behaviors, add the next SQL migration,
then run `pnpm db:generate` and `pnpm db:check`. Generation writes the complete current `db/schema.sql` snapshot,
checks every typed table/column, and leaves migration files untouched. Setup verifies recorded checksums and the
complete catalog before and after upgrading, and records successful versions in `envoy_meta.migrations` in the same
transaction. BullMQ manages its separate schema through its official API. Health and Worker startup require the
current application migration checksums.
English table and column comments are maintained in `src/platform/database/schema/documentation.ts`; generation
requires a nonempty description for every typed table and column, and initialization validates the stored comments.

Tests create and remove a unique isolated database for each run. Set `TEST_DATABASE_ADMIN_URL` to a PostgreSQL
connection allowed to create databases (default: `postgresql://envoy:envoy@localhost:5432/postgres`); tests derive their
connection from it and never reset a shared development database.

Attachment safety belongs entirely to Envoy. Upload success means durable receipt; callers wait for `usage.canSend`
before sending. All outbound/inline attachments and inbound downloads require a byte-bound current clean result;
scanner absence or timeout fails closed. Start the PostgreSQL worker and configure the scanner **only in Envoy**.
The **Attachment Safety** console distinguishes configuration from observed task results. See the
[API and architecture contract, runnable flow and Morph/Sonaops cutover checklist](docs/ATTACHMENT-SAFETY.md).
Do not remove business-side scanners until this Envoy capability is verified and available in the target deployment.


Deadline-bound sensitive sends use `sendBefore` plus `contentPolicy: "sensitive"`; check `messagePolicies` in capabilities before use. Sensitive free-form payloads and provider raw receipts are envelope-encrypted, API/admin never reveal the content, and a mandatory worker sweep removes expired encrypted bodies while preserving receipts and real delivery facts. Sensitive requests require a deadline within 15 minutes. Deadline checks reach the final HTTP write after DNS/TLS; unknown or already accepted outcomes never become automatic resends. See [the API contract](docs/API.md#sending-deadline-and-sensitive-content) for exact fields, retained metadata, independent file policies and cleanup limits.
