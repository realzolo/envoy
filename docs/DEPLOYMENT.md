# PM2 Production Deployment

Envoy is built once on a trusted build machine and deployed as an immutable release artifact. The server runs two
independent PM2 processes behind Nginx:

- `envoy-web` serves the Next.js console, service API, health endpoint, and provider ingress on `127.0.0.1:6178`.
- `envoy-worker` processes delivery, provider events, inbound mail, callbacks, reconciliation, and the transactional outbox.

Both processes require the same `.env.local`, PostgreSQL, Redis, R2 credentials, and encryption root. PM2 is only the
process supervisor; Nginx terminates TLS and is the only public listener.

## Prerequisites

Build machine:

- Node.js 20.9 or newer, pnpm 10, Git, tar, and access to the test PostgreSQL/Redis services.
- Prefer a Linux CI runner matching the production server architecture.

Production server:

- A dedicated `envoy` Linux user, Node.js 20.9 or newer, pnpm 10, PM2, curl, and Nginx.
- A private PostgreSQL database and authenticated Redis instance reachable from the server.
- ClamAV reachable from the Worker when inbound mail or attachments are enabled.
- Public DNS for the console and provider webhook endpoint.

Do not use the repository `docker-compose.yml` in production. It contains local development credentials and publishes
database ports.

## Build The Artifact

Build from the exact commit being released:

```bash
git checkout <release-commit>
pnpm release:build
```

The command installs locked dependencies, runs type checking, lint, tests, and the production build, then creates:

```text
dist/envoy-<commit>-<timestamp>.tar.gz
```

The archive intentionally excludes `node_modules` and `.env.local`. The server installs dependencies for its own
platform and retains secrets outside release directories. `ENVOY_SKIP_TESTS=1` may skip tests only when a preceding CI
stage already passed them. Dirty worktrees are rejected unless `ENVOY_ALLOW_DIRTY_RELEASE=1` is explicitly set.

Upload the archive:

```bash
scp dist/envoy-<release>.tar.gz deploy@server:/tmp/
```

## Prepare The Server

Install the runtime and process supervisor, then create persistent release and secret directories:

```bash
sudo corepack enable
sudo corepack prepare pnpm@10.33.0 --activate
sudo npm install --global pm2

sudo mkdir -p /opt/envoy/releases /etc/envoy
sudo chown -R envoy:envoy /opt/envoy
```

## Deploy An Artifact

Extract the archive into a new release directory and link the persistent environment file:

```bash
cd /tmp
release=/opt/envoy/releases/<release>
sudo -u envoy mkdir -p "$release"
sudo -u envoy tar -xzf "/tmp/envoy-<release>.tar.gz" -C "$release"
if ! sudo test -f /etc/envoy/envoy.env; then
  sudo install -m 600 -o envoy -g envoy "$release/deploy/env.production.example" /etc/envoy/envoy.env
  sudoedit /etc/envoy/envoy.env
fi
sudo -u envoy ln -s /etc/envoy/envoy.env "$release/.env.local"

cd "$release"
sudo -u envoy ./scripts/deploy-pm2.sh
sudo -u envoy ln -sfn "$release" /opt/envoy/current
```

Create `/etc/envoy/envoy.env` only on the first deployment; keep the existing file during subsequent releases. The
Redis password must be URL encoded. Use `/0` explicitly unless a different Redis database is intentional. Back up
`ENVOY_KEK_BASE64` separately: losing it makes encrypted provider and callback credentials unrecoverable.

The deployment script refuses to continue without the uploaded `.next/BUILD_ID`. It installs locked dependencies for
the server platform, applies the V1 migration, starts or reloads both PM2 processes, and saves the PM2 state only after
both processes are online and `/api/health` reports `ok`.

An emergency server-side build remains available but is intentionally opt-in:

```bash
ENVOY_BUILD_ON_SERVER=1 ./scripts/deploy-pm2.sh
```

Enable the application user's PM2 state at boot using the command printed by `pm2 startup`, then save once more:

```bash
pm2 startup
pm2 save
```

`pm2 startup` usually prints a privileged command. Review and run that exact command rather than running the application
itself as root.

## Nginx And TLS

Copy `deploy/nginx/envoy.conf.example` to the Nginx site directory, replace `envoy.example.com`, and provision the TLS
certificate before enabling the HTTPS server. The template proxies to port `6178` and accepts payloads up to 32 MiB for
inbound MIME and attachments.

```bash
sudo cp deploy/nginx/envoy.conf.example /etc/nginx/sites-available/envoy.conf
sudo ln -s /etc/nginx/sites-available/envoy.conf /etc/nginx/sites-enabled/envoy.conf
sudo nginx -t
sudo systemctl reload nginx
```

Provider webhook URLs use the public HTTPS origin:

```text
https://envoy.example.com/api/provider-events/{provider}/{opaqueEndpointId}
```

## Operations And Rollback

```bash
pm2 status
pm2 logs envoy-web
pm2 logs envoy-worker
pm2 monit
curl --fail https://envoy.example.com/api/health
```

Deploy subsequent revisions as new immutable release directories. Do not overwrite an existing release. Roll back code
by deploying from a prior release directory; database migrations are forward-only and are not reverted automatically:

```bash
cd /opt/envoy/releases/<prior-release>
./scripts/deploy-pm2.sh
ln -sfn /opt/envoy/releases/<prior-release> /opt/envoy/current
```

Start with one Web process and one Worker. Multiple Web instances require coordinated Next.js build IDs, Server Action
encryption, and shared cache behavior. Multiple Workers are supported by BullMQ and database idempotency, but should be
scaled only after observing queue load and provider limits.

## Required Readiness Checks

Do not direct production traffic until all of these pass:

1. `pnpm db:migrate` applies `001_initial.sql` to the intended database.
2. The authenticated `REDIS_URL` responds without `NOAUTH`.
3. `/api/health` returns HTTP 200 with `status: ok`.
4. R2 read/write succeeds under the `envoy/` prefix.
5. ClamAV is reachable when inbound mail is enabled.
6. The admin password is no longer a placeholder.
7. Provider ingress and business callback URLs use valid public HTTPS origins.
