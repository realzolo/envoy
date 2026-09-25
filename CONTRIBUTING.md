# Contributing to Envoy

Thanks for contributing. Envoy is a self-hosted, single-instance email control plane. Keep changes small, explicit,
and focused on reliable message delivery and operations.

## Before You Start

- Read [README.md](README.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and the relevant provider documentation.
- Do not commit provider API keys, webhook secrets, database URLs, or production data. Use `.env.example` as the
  configuration reference.
- Discuss a change that affects the public API, persistence model, provider contract, or deployment flow before doing
  substantial implementation work.

## Local Development

Use Node.js 20.9 or newer and the pnpm version declared in `package.json`.

```bash
pnpm install
pnpm db:setup
pnpm dev:all
```

Run the full verification set before opening a pull request:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` creates and drops the `envoy_test` database. Point `TEST_DATABASE_ADMIN_URL` only at a PostgreSQL
instance where that database may be removed.

## Change Expectations

- Prefer small, reviewable pull requests with tests covering behavior changes.
- Keep provider-specific behavior inside `src/modules/providers`; do not expose provider credentials or payloads to
  the service API.
- Add an ordered migration for a normal schema change. Alter the baseline migration only for an explicitly documented
  fresh-database release; that release must not claim in-place upgrade compatibility.
- Update the relevant deployment, architecture, or operator documentation when runtime behavior changes.
- Run formatting only on files you intentionally changed. Preserve unrelated work in a shared checkout.

## Pull Requests

Explain the user-visible impact, testing performed, operational considerations, and any migration or configuration
steps. Keep the CI checks green. Maintainers may ask for a smaller scope when a proposal combines independent changes.

## Security Issues

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).
