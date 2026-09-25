# Envoy Docker Deployment

The production server checks out the source and builds one Docker image. Docker Compose runs the Web and Worker as
separate containers, executes database migration as a one-off task, and attaches all three services to the explicit
`envoy-network` bridge network. PostgreSQL, Redis, and R2 remain external.

## Requirements

- Git
- Docker Engine
- Docker Compose v2

## Baseline Schema Release

This release requires a new, empty PostgreSQL database. It changes the baseline schema and does not provide an in-place
upgrade path from an earlier Envoy database. Export or retain any required data separately, provision the new database,
then run the normal migration task during initial deployment.

## Checkout And Configure

```bash
git clone REPLACE_WITH_REPOSITORY_URL /data/envoy
cd /data/envoy
cp deploy/env.production.example .env.production
vi .env.production
```

Replace every active `replace_with_*` value. Ensure the database, authenticated Redis, R2 credentials, KEK,
administrator
credentials and session secret are correct. ClamAV is optional; without it, attachments skip scanning and receive the
`skipped` status. `.env.production` is ignored by Git and excluded from the Docker build context.

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

Do not use this update procedure to upgrade an existing database to the baseline-schema release above. It applies after
that release has been initialized on a fresh database.

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

To roll back, check out the prior commit and repeat build, migration, and startup. Database migrations are forward-only,
so confirm the older code is compatible with the current schema first.
