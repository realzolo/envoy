#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${ENVOY_APP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
HEALTH_URL="${ENVOY_HEALTH_URL:-http://127.0.0.1:6178/api/health}"

cd "$APP_ROOT"

for command in node pnpm pm2 curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is unavailable: $command" >&2
    exit 1
  fi
done

if [[ ! -f .env.local ]]; then
  echo "Missing $APP_ROOT/.env.local. Create it from deploy/env.production.example." >&2
  exit 1
fi

if [[ "${ENVOY_BUILD_ON_SERVER:-0}" != "1" ]] && [[ ! -f .next/BUILD_ID ]]; then
  echo "Missing prebuilt .next/BUILD_ID. Upload a release artifact or set ENVOY_BUILD_ON_SERVER=1." >&2
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1)'; then
  echo "Node.js 20.9 or newer is required." >&2
  exit 1
fi

pnpm install --frozen-lockfile
if [[ "${ENVOY_BUILD_ON_SERVER:-0}" == "1" ]]; then
  pnpm typecheck
  pnpm lint
  pnpm build
fi
NODE_ENV=production pnpm db:migrate

pm2 startOrReload ecosystem.config.cjs --update-env

process_online() {
  local pid
  pid="$(pm2 pid "$1" | tr -d '[:space:]')"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]]
}

for attempt in {1..30}; do
  if process_online envoy-web && process_online envoy-worker && response="$(curl --fail --silent --show-error "$HEALTH_URL" 2>/dev/null)"; then
    if [[ "$response" == *'"status":"ok"'* ]]; then
      pm2 save
      echo "Envoy Web and Worker are online; health check passed at $HEALTH_URL"
      exit 0
    fi
  fi
  sleep 1
done

echo "Envoy failed its health check at $HEALTH_URL" >&2
pm2 status >&2 || true
exit 1
