# Envoy

Envoy is a provider-neutral email control plane and delivery data plane for internal products and services. Business
services submit recipients and final rendered subject, HTML, and/or plain text. Envoy owns sender identity, provider
routing, credentials, delivery state, inbound mail, suppressions, and canonical callbacks. Business content definitions,
localization, and rendering remain in the calling service.

## Architecture

- Next.js serves the internal Message API, provider event ingress, authentication, and the operations console.
- A separate TypeScript worker runs delivery, event normalization, inbound processing, callbacks, reconciliation, and
  transactional outbox dispatch.
- PostgreSQL is the only source of truth. Redis and BullMQ are scheduling infrastructure only.
- Provider credentials are stored as envelope-encrypted database records. Every secret has an independent AES-256-GCM
  data key wrapped by the configured root KEK.
- Envoy never stores or renders business content definitions. Persisted content is the immutable send payload needed for
  delivery, support, callbacks, and configured retention.
- One logical delivery is created per recipient. Every provider call creates an immutable attempt with a complete
  routing decision snapshot.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the domain model, failure semantics, provider setup, inbound
pipeline, and security model.

## Local setup

Requirements: Node.js, pnpm, and Docker.

```bash
pnpm install
pnpm infra:up
pnpm db:setup
pnpm dev:all
```

Open [http://localhost:6178](http://localhost:6178) and sign in with the development credentials from `.env.local`:

- Email: `admin@envoy.local`
- Password: `envoy`

The database starts with no products, services, domains, providers, messages, or inbound mail. Create the first product
under **Service Credentials**, then configure real provider accounts and their write-only credentials under
**Provider Accounts**. No provider key belongs in an environment file.

The web process and worker are intentionally separate. In production, run `pnpm start` and `pnpm worker` as
independently scalable processes. Both require PostgreSQL and Redis; only the worker performs provider sends, event
application, callbacks, and reconciliation.

## Message API

```bash
curl --request POST http://localhost:6178/api/v1/messages \
  --header "Authorization: Bearer $ENVOY_SERVICE_KEY" \
  --header 'Idempotency-Key: login-attempt-456' \
  --header 'Content-Type: application/json' \
  --data '{
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
transaction. The request contract rejects provider names, provider accounts, domains, scheduling options, and other
provider-specific fields.

The service API is self-describing at `GET /api/v1` and `GET /api/v1/openapi.json`. Authenticated resources include:

| Resource | Operations |
|----------|------------|
| `/messages` | Queue and list messages |
| `/messages/{id}` | Inspect final content and recipient deliveries |
| `/messages/{id}/cancel` | Cancel deliveries that have not crossed the provider boundary |
| `/messages/{id}/retry` | Retry eligible outcomes with duplicate-risk acknowledgement for unknown outcomes |
| `/deliveries` | List recipient-level deliveries and inspect attempts |
| `/events` | Read normalized delivery events |
| `/inbound-messages` | List and inspect sanitized inbound mail |
| `/suppressions` | Check, create, and remove product-owned suppressions |
| `/senders` | Discover logical sender profiles available to the product |
| `/capabilities` | Discover limits, content rules, and available senders |

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

The HTTP path verifies the provider signature and replay window, stores the immutable raw event plus an outbox record in
one transaction, and returns immediately. Workers normalize and apply canonical events asynchronously.

Open **Inbound** to inspect sanitized messages received from configured production providers and **Audit & Revisions**
to verify signed business callbacks.

## Production deployment

The supported PM2 deployment uses a prebuilt release artifact and runs the Next.js Web process and asynchronous Worker
independently behind Nginx. The default application port is `6178`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the
build, upload, production environment, migration, PM2 startup, TLS proxy, health check, and rollback procedure.
Chinese documentation is available at [docs/DEPLOYMENT.zh-CN.md](docs/DEPLOYMENT.zh-CN.md).

## Commands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm worker
pnpm infra:down
```

All provider credentials, webhook secrets, and callback signing secrets live in encrypted database envelopes. The
environment contains root infrastructure trust only: database, Redis, the KEK, admin authentication, object storage,
scanner connectivity, and worker tuning.
