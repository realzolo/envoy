# Envoy Docker Deployment

The production server checks out the source and builds one Docker image. Docker Compose runs the Web and Worker as
separate containers and executes database migration as a one-off task. PostgreSQL, Redis, and R2 remain external.

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

Replace every `replace_with_*` value. Ensure the database, authenticated Redis, R2 credentials, KEK, administrator
credentials, session secret, and optional ClamAV endpoint are correct. `.env.production` is ignored by Git and excluded
from the Docker build context.

## Build And Start

```bash
docker compose build
docker compose run --rm migrate
docker compose up -d web worker
```

Envoy is published on port `6178`. Verify the deployment:

```bash
docker compose ps
curl --fail http://127.0.0.1:6178/api/health
```

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

To roll back, check out the prior commit and repeat build, migration, and startup. Database migrations are forward-only,
so confirm the older code is compatible with the current schema first.
