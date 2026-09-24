#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${ENVOY_RELEASE_DIR:-$APP_ROOT/dist}"

cd "$APP_ROOT"

for command in git node pnpm tar; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is unavailable: $command" >&2
    exit 1
  fi
done

if [[ "${ENVOY_ALLOW_DIRTY_RELEASE:-0}" != "1" ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to package a dirty worktree. Commit changes or set ENVOY_ALLOW_DIRTY_RELEASE=1." >&2
  exit 1
fi

pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
if [[ "${ENVOY_SKIP_TESTS:-0}" != "1" ]]; then
  pnpm test
fi
pnpm build

release_id="${ENVOY_RELEASE_ID:-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)}"
archive="$OUTPUT_DIR/envoy-$release_id.tar.gz"
paths=(
  .next
  db
  deploy
  docs/DEPLOYMENT.md
  scripts/deploy-pm2.sh
  scripts/migrate.ts
  src
  .env.example
  ecosystem.config.cjs
  next.config.ts
  package.json
  pnpm-lock.yaml
  README.md
  tsconfig.json
)

if [[ -d public ]]; then
  paths+=(public)
fi

mkdir -p "$OUTPUT_DIR"
tar --exclude='.next/cache' --exclude='.next/dev' -czf "$archive" "${paths[@]}"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUTPUT_DIR" && sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256")
else
  (cd "$OUTPUT_DIR" && shasum -a 256 "$(basename "$archive")" > "$(basename "$archive").sha256")
fi

echo "Release artifact: $archive"
echo "Checksum: $archive.sha256"
