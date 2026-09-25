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
  delivery, support, and callbacks.
- One logical delivery is created per recipient. Every provider call creates an immutable attempt with a complete
  routing decision snapshot.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the domain model, failure semantics, provider setup, inbound
pipeline, and security model.

## Project Documentation

- [Deployment guide](docs/DEPLOYMENT.md)
- [Release and operations guide](docs/OPERATIONS.md)
- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Local setup

Requirements: Node.js, pnpm, and configured PostgreSQL and Redis connections in `.env.local`.

Create `.env.local` from `.env.example` and set an explicit administrator email, password, session secret, and KEK before
starting the application.

> **Fresh database required:** this baseline-schema release initializes a new, empty database only. It has no in-place
> upgrade compatibility with earlier Envoy schemas.

```bash
pnpm install
pnpm db:setup
pnpm dev:all
```

Open [http://localhost:6178](http://localhost:6178) and sign in with the `ENVOY_ADMIN_EMAIL` and
`ENVOY_ADMIN_PASSWORD` values from `.env.local`.

The database starts with no products, services, domains, providers, messages, or inbound mail. Create the first product
under **Service Credentials**, then configure real provider accounts and their write-only credentials under **Provider
Accounts**. No provider key belongs in an environment file.

The web process and worker are intentionally separate. The production Compose file runs them as independently
restartable containers from one image. Both require PostgreSQL and Redis; only the worker performs provider sends,
event application, callbacks, and reconciliation.

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

| Resource                | Operations                                                                       |
|-------------------------|----------------------------------------------------------------------------------|
| `/messages`             | Queue and list messages                                                          |
| `/messages/{id}`        | Inspect final content and recipient deliveries                                   |
| `/messages/{id}/cancel` | Cancel deliveries that have not crossed the provider boundary                    |
| `/messages/{id}/retry`  | Retry eligible outcomes with duplicate-risk acknowledgement for unknown outcomes |
| `/deliveries`           | List recipient-level deliveries and inspect attempts                             |
| `/events`               | Read normalized delivery events                                                  |
| `/inbound-messages`     | List and inspect sanitized inbound mail                                          |
| `/suppressions`         | Check, create, and remove product-owned suppressions                             |
| `/senders`              | Discover sender profiles available to the product                                |
| `/capabilities`         | Discover limits, content rules, and available senders                            |

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
signed business callback delivery, and **Audit Log** to review administrator actions.

## Production deployment

Production deployment builds the Docker image from a server-side Git checkout and runs separate Web and Worker
containers with Docker Compose. The application binds to loopback port `6178`; an HTTPS reverse proxy on the same host
publishes it. PostgreSQL, Redis, R2, and secrets are provided through `.env.production`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) or the
[Chinese guide](docs/DEPLOYMENT.zh-CN.md).

## Commands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm worker
```

All provider credentials, webhook secrets, and callback signing secrets live in encrypted database envelopes. The
environment contains root infrastructure trust only: database, Redis, the KEK, admin authentication, object storage,
scanner connectivity, and worker tuning.
