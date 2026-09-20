# Envoy

Envoy is a provider-neutral email control plane and delivery data plane for internal products and services. Business services submit a template key, recipients, locale, variables, reference ID, and metadata. Envoy owns rendering, sender identity, provider routing, credentials, delivery state, inbound mail, suppressions, and canonical callbacks.

## Architecture

- Next.js serves the internal Message API, provider event ingress, authentication, and the operations console.
- A separate TypeScript worker runs delivery, event normalization, inbound processing, callbacks, reconciliation, and transactional outbox dispatch.
- PostgreSQL is the only source of truth. Redis and BullMQ are scheduling infrastructure only.
- Provider credentials are stored as envelope-encrypted database records. Every secret has an independent AES-256-GCM data key wrapped by the configured root KEK.
- Templates are rendered by Envoy into final HTML and text. Providers never own business templates.
- One logical delivery is created per recipient. Every provider call creates an immutable attempt with a complete routing decision snapshot.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the domain model, failure semantics, provider setup, inbound pipeline, and security model.

## Local setup

Requirements: Node.js, pnpm, and Docker.

```bash
pnpm install
pnpm infra:up
pnpm db:setup
pnpm dev:all
```

Open [http://localhost:3000](http://localhost:3000) and sign in with the development credentials from `.env.local`:

- Email: `admin@envoy.local`
- Password: `envoy`

The seed creates one active Mock provider account. Real provider accounts and their write-only credentials are created in **Provider Accounts**; no provider key belongs in an environment file.

The web process and worker are intentionally separate. In production, run `pnpm start` and `pnpm worker` as independently scalable processes. Both require PostgreSQL and Redis; only the worker performs provider sends, event application, callbacks, and reconciliation.

## Message API

```bash
curl --request POST http://localhost:3000/api/v1/messages \
  --header 'Authorization: Bearer envoy_dev_key' \
  --header 'Idempotency-Key: login-attempt-456' \
  --header 'Content-Type: application/json' \
  --data '{
    "template": "auth.login-code",
    "to": [{ "email": "developer@example.com", "name": "Developer" }],
    "locale": "en-US",
    "variables": {
      "code": "482901",
      "expiresInMinutes": 10,
      "userName": "Developer",
      "productName": "Atlas"
    },
    "referenceId": "login_attempt_456",
    "metadata": { "environment": "development" }
  }'
```

The API returns `202 Accepted` after the message, recipient deliveries, and outbox records commit in one PostgreSQL transaction. The request contract rejects provider names, provider accounts, domains, scheduling options, and other provider-specific fields.

Query status with the same service credential:

```bash
curl http://localhost:3000/api/v1/messages/msg_example \
  --header 'Authorization: Bearer envoy_dev_key'
```

## Provider event ingress

Each provider account receives an opaque endpoint:

```text
POST /api/provider-events/{provider}/{opaqueEndpointId}
```

The HTTP path verifies the provider signature and replay window, stores the immutable raw event plus an outbox record in one transaction, and returns immediately. Workers normalize and apply canonical events asynchronously.

For a local inbound smoke test against the seeded Mock endpoint:

```bash
curl --request POST http://localhost:3000/api/provider-events/mock/mock-local-endpoint \
  --header 'Authorization: Bearer local-mock-webhook' \
  --header 'Content-Type: application/json' \
  --data '{
    "id": "inbound-local-1",
    "type": "inbound.received",
    "externalMessageId": "mock-inbound-local-1",
    "from": "sender@example.net",
    "to": ["support@mail.atlas.example"],
    "subject": "Local inbound test",
    "html": "<p>Inbound content</p>",
    "text": "Inbound content"
  }'
```

Open **Inbound** to inspect the sanitized message and **Audit & Revisions** to verify the signed local callback.

## Commands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm worker
pnpm infra:down
```

All provider credentials, webhook secrets, and callback signing secrets live in encrypted database envelopes. The environment contains root infrastructure trust only: database, Redis, the KEK, admin authentication, object storage, scanner connectivity, and worker tuning.
