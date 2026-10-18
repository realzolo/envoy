# Envoy Docker Deployment

The production server checks out the source and builds one Docker image. Docker Compose runs the Web and Worker as
separate containers, executes database migration as a one-off task, and attaches all three services to the explicit
`envoy-network` bridge network. PostgreSQL and R2 remain external.

## Requirements

- Git
- Docker Engine
- Docker Compose v2

## Checkout And Configure

```bash
git clone REPLACE_WITH_REPOSITORY_URL /data/envoy
cd /data/envoy
cp deploy/env.production.example .env.production
vi .env.production
```

Replace every active `replace_with_*` value. Ensure the database, R2 credentials, KEK,
administrator
credentials and session secret are correct. Configure the Envoy-only scanner for attachment use; without it, files remain unavailable and are never silently approved. See [Attachment Safety](ATTACHMENT-SAFETY.md). `.env.production` is ignored by Git and excluded from the Docker build context.

## Build And Start

```bash
docker compose build
docker compose run --rm migrate
docker compose up -d web worker
```

Envoy binds port `6178` to `127.0.0.1` only. Put an HTTPS reverse proxy on the same host in front of it; do not expose
the Compose port directly to the internet. Verify the deployment:

```bash
docker compose ps
curl --fail http://127.0.0.1:6178/api/health
```

The session cookie follows the browser-facing protocol. HTTPS reverse proxies must forward `X-Forwarded-Proto`.
Set `ENVOY_TRUST_PROXY=true` only when that proxy overwrites client-supplied `X-Forwarded-*` headers and the Envoy
port is not directly reachable by untrusted clients. This is required when provider IP allowlists are used behind a
reverse proxy. Use HTTPS for public deployments.

Outbound callback endpoints must be public HTTPS addresses by default. For trusted private-network consumers, set
`ENVOY_ALLOW_PRIVATE_CALLBACKS=true`; this also permits HTTP only for private outbound callback addresses.

## Update

```bash
cd /data/envoy
git pull --ff-only
docker compose build
docker compose run --rm migrate
docker compose up -d web worker
```

## Operations

```bash
docker compose logs -f web
docker compose logs -f worker
docker compose restart web worker
docker compose down
```

For fresh installations, `001_initial.sql` directly creates the final domain authorization model, domain-owned files, Service-scoped inbound routes and one callback with one current secret per Service.
Migration still refuses a checksum mismatch; no data-bearing database is reset and no ledger is rewritten to force startup. Deploy matching Web and Worker binaries together. For an attachment policy change, follow the
stopped/drained all-instance procedure in [Operations](OPERATIONS.md#attachment-safety-operations).

Use PostgreSQL 14+ with direct or session-pooled connections. Default Web plus Worker connection budget is 48, plus deployment/monitoring headroom. Migration initializes business and BullMQ schemas explicitly. R2 uses separate `OBJECT_STORE_ACCESS_KEY_ID` / `OBJECT_STORE_SECRET_ACCESS_KEY`; AWS runtime credentials remain available to SES. Leave SSE unset for R2 and use bucket-default encryption.
