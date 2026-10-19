# Production Deployment

This guide deploys Envoy from a server-side Git checkout using Docker Compose. Commands assume the repository is
installed at `/data/envoy` and the current user can run Docker commands.

The Compose configuration runs three services from the same application image:

| Service | Responsibility |
| --- | --- |
| `web` | Next.js application, operations console, API, and provider event ingress |
| `worker` | Delivery, event processing, callbacks, attachment scanning jobs, and background maintenance |
| `migrate` | Ordered application schema initialization/upgrades and official BullMQ initialization |

## Requirements

- A Linux server with Git, Docker Engine, Docker Compose v2, curl, and OpenSSL.
- PostgreSQL 14 or newer with a database accessible from the application containers.
- S3-compatible object storage, such as Cloudflare R2, for production content and attachments.
- A reachable ClamAV scanner with current signatures when `CLAMAV_HOST` is configured. Without it, attachments receive integrity verification but no malware screening.

Use direct or session-pooled PostgreSQL connections. Transaction-pooled connections cannot preserve the `LISTEN`
sessions used by the queue backend. The setup role needs permission to create schemas, application objects and the
BullMQ schema. Web and Worker do not execute schema DDL.

Node.js and pnpm are provided by the Docker image build.

Check the server tools:

```bash
git --version
docker version
docker compose version
```

## 1. Check Out the Repository

```bash
git clone https://github.com/realzolo/envoy.git /data/envoy
cd /data/envoy
```

## 2. Create Server Configuration

Run these commands once for a new installation:

```bash
cp docker-compose.example.yml docker-compose.yml
cp .env.example .env.production
chmod 600 .env.production
```

The repository maintains one environment reference, `.env.example`. Development uses `.env.local`; Docker production
uses `.env.production` through Compose's `env_file` setting.

Both `docker-compose.yml` and `.env.production` are ignored by Git. Keep server-specific changes in those files and
review changes to the committed examples when upgrading. Do not overwrite existing server configuration with the copy
commands above during an update. Environment files are also excluded from the Docker build context.

Edit the production environment:

```bash
vi .env.production
```

The example defaults to local development. Configure these values before starting production:

The production image rejects `local` or an unknown object storage driver before starting any Compose service.
Web and Worker must use the same S3 bucket, region, endpoint, prefix and credentials. A writable directory inside
the Web container does not make uploaded files available to Worker, and a container restart can remove them.

| Setting | Production configuration |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string reachable from the containers; use the TLS settings required by your database provider |
| `ENVOY_KEK_BASE64` | A base64-encoded key that decodes to exactly 32 bytes |
| `ENVOY_KEK_VERSION` | A stable identifier for the current encryption key, such as `kek-1` |
| `ENVOY_ADMIN_EMAIL` | Administrator login email |
| `ENVOY_ADMIN_PASSWORD` | A strong administrator password |
| `ENVOY_SESSION_SECRET` | A randomly generated session signing secret |
| `OBJECT_STORAGE_DRIVER` | Set to `s3`; the `local` driver is for development |
| `OBJECT_STORAGE_BUCKET` | Production storage bucket |
| `OBJECT_STORAGE_REGION` | Storage region; use `auto` for R2 |
| `OBJECT_STORAGE_ENDPOINT` | Account-specific endpoint for R2 or another S3-compatible service |
| `OBJECT_STORE_ACCESS_KEY_ID` | Object storage access key |
| `OBJECT_STORE_SECRET_ACCESS_KEY` | Object storage secret key |
| `CLAMAV_HOST` / `CLAMAV_PORT` | Scanner address reachable from the worker; the default port is `3310` |

Uncomment the storage and scanner settings you need, and replace every active `replace_with_*` value. Leave `CLAMAV_HOST` unset on both Web and Worker when malware scanning is not enabled; setting it on both requires clean scanner results.
Inside a container, `localhost` refers to that container. Use addresses reachable from the application containers for
PostgreSQL and ClamAV.

Generate the KEK and session secret separately, then copy each result into its corresponding setting:

```bash
# ENVOY_KEK_BASE64
openssl rand -base64 32

# ENVOY_SESSION_SECRET
openssl rand -hex 32
```

Back up the KEK separately from the database. Preserve its value and version across deployments; losing it makes
existing encrypted credentials unreadable. Keep prior keys in `ENVOY_KEK_KEYRING_JSON` when rotating versioned keys.

For R2, use `OBJECT_STORAGE_REGION=auto` and an endpoint in the form
`https://ACCOUNT_ID.r2.cloudflarestorage.com`. Use bucket-default encryption and leave
`OBJECT_STORE_SERVER_SIDE_ENCRYPTION` unset. R2 credentials use the `OBJECT_STORE_*` settings independently of AWS
runtime credentials used by SES.
When a custom S3 endpoint is configured, both `OBJECT_STORE_ACCESS_KEY_ID` and
`OBJECT_STORE_SECRET_ACCESS_KEY` are required; the process does not fall back to AWS credentials for that endpoint.
For AWS S3 without a custom endpoint, the default AWS credential chain may be used.

The Docker image sets `NODE_ENV=production`; it does not need to be added to the environment file. Server processes
use UTC by default. Keep `PORT=6178` unless you also update the Compose port mapping and health check.

## 3. Build and Start

Validate the configuration first:

```bash
docker compose config --quiet
```

After validation succeeds, build and start the services:

```bash
docker compose up -d --build
```

Compose builds the shared `envoy:production` image, runs `migrate`, and starts Web and Worker only after migration
success. Setup initializes empty databases or validates and applies missing ordered application migrations, then
initializes BullMQ through its official API. Each applied file has a SHA-256 record in `envoy_meta.migrations`.
One transaction-scoped advisory lock serializes upgrades; full catalog comparison detects schema/comment drift before
and after SQL execution. Failed SQL rolls the application upgrade back without clearing business data.

This fresh-project `001_initial.sql` includes the complete application schema and outbound change stream. Initialize a
new database for this version; a nonempty application schema without a migration journal is rejected. Future upgrades
append ordered SQL versions and preserve matching journaled data. Unknown structures or changed applied checksums are rejected.

Maintain typed schema and English comments, add the next migration and checksum, then run `pnpm db:generate` to
update `db/schema.sql` and `pnpm db:check`. Generation checks every table/column and never rewrites migration files.

The default port mapping exposes the application on the server at `http://127.0.0.1:6178`. Public HTTPS access is
configured separately.

## 4. Verify the Deployment

```bash
docker compose ps -a
docker compose logs --tail=100 web worker migrate
curl --fail http://127.0.0.1:6178/api/health
```

A healthy API response is:

```json
{"name":"envoy","status":"ok"}
```

Expected service states:

| Service | Expected result |
| --- | --- |
| `migrate` | `Exited (0)` after completing successfully |
| `web` | Running; health changes from `starting` to `healthy` after checks pass |
| `worker` | Running; logs include `Envoy PostgreSQL workers started` |

The health endpoint checks database access, application migration checksums, queue schema compatibility, and the outbox query. It does not confirm
that Worker is running, storage is accessible, attachments can be scanned, or a provider can send mail. Check Worker
logs and its heartbeat in the operations console separately.

Sign in using `ENVOY_ADMIN_EMAIL` and `ENVOY_ADMIN_PASSWORD`. A new database has no business configuration: create
service credentials, configure provider accounts and domains, then bind a domain to the Service with an outbound identity before sending a test message.
Provider API keys and webhook secrets belong in the operations console, where they are encrypted in the database.

## 5. Update an Existing Deployment

Before updating, back up PostgreSQL, including its `bullmq` schema, and preserve the production environment, KEKs,
and required object storage data. Review configuration changes, ordered migrations and their checksums. Stop and drain
writers before a migration requiring table locks. Apply the migration task successfully before starting the matching
Web and Worker processes. This reset V1 requires a newly initialized database; future ordered upgrades operate on journaled databases.

Pull the source without overwriting the server's configuration files:

```bash
cd /data/envoy
git switch main
git pull --ff-only
```

Keep the deployment checkout on `main`; merge changes into `main` before deploying them.

Apply any required configuration changes, then run:

```bash
docker compose config --quiet &&
docker compose build web &&
docker compose run --rm --no-deps migrate &&
docker compose up -d --no-deps --force-recreate web worker
```

The commands are chained so a failure stops the remaining steps. The new image is built once, migration must succeed
before application containers are replaced, and both Web and Worker use the newly built image. `--no-deps` avoids
running the migration again after the explicit migration step. Container recreation causes a brief service interruption.

Repeat the deployment verification commands after every update. For attachment policy changes, follow the drain and
stop procedure in [Operations](OPERATIONS.md#attachment-safety-operations) before replacing running instances.

## 6. Routine Operations

```bash
# Inspect all service states, including the completed migration task.
docker compose ps -a

# Follow application logs.
docker compose logs -f web worker

# Restart existing application containers.
docker compose restart web worker

# Stop application containers while retaining them.
docker compose stop web worker

# Remove the deployment's containers.
docker compose down
```

After changing `.env.production`, recreate the application containers to load the new values:

```bash
docker compose config --quiet &&
docker compose up -d --no-deps --force-recreate web worker
```

`docker compose restart` keeps the existing container environment. Shutting down Compose does not delete data stored
in PostgreSQL or object storage.

## Troubleshooting

| Symptom | Checks |
| --- | --- |
| Build fails | Check Docker build output, registry access, package downloads, and available disk space and memory. |
| `migrate` exits with a nonzero code | Read migration logs; check the database URL, database permissions, and schema compatibility before starting Web or Worker. |
| Setup reports catalog or checksum drift | Inspect the mismatch and restore the expected recorded schema/source through a reviewed repair; do not delete the database or alter executed migration files. |
| Web remains unhealthy or `/api/health` returns `503` | Inspect Web logs and verify database connectivity and both application and queue schemas. |
| Worker exits or messages remain queued | Inspect Worker logs, its console heartbeat, database connectivity, provider configuration, and routing. |
| Administrator login fails | Verify the configured email and password and recreate containers after environment changes. |
| Attachments remain unavailable | Verify storage credentials, bucket access, Worker logs, and consistent `CLAMAV_HOST` configuration on Web and Worker. When configured, also verify scanner connectivity and signatures; failing scanners block attachment use. |

To inspect a failed migration container:

```bash
docker compose logs --tail=200 migrate
```

When a migration was run with `docker compose run --rm`, inspect its terminal output because the temporary container
is removed after exit.

## Rollback

Check out a known compatible source revision and repeat the build, migration, and container recreation steps above.
Confirm that the older application and queue backend support the current database schema before rolling back. Application rollback does not reverse database
structures. Restore backups only through a planned database recovery procedure.

For ongoing delivery, credential rotation, retention, and recovery procedures, see [Operations](OPERATIONS.md).
