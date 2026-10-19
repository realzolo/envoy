@AGENTS.md

# Business mail architecture

Read `docs/ARCHITECTURE.md` and `docs/API.md` for the final domain-permission contract. Envoy owns business Service identities, rotating Service Keys, domain sending/receiving grants and one unified callback per Service. Business APPs, exact mailbox purposes, templates and APP dispatch belong to callers.

`service_domain_grants` is the sole business mail authorization authority. Service is the sole business identity and isolation boundary for credentials, messages, files, domain permissions, callbacks and recipient suppression rules. Every protected resource and background network operation must check ownership and current frozen domain permissions, including after storage or DNS waits at the final network boundary. Files require `X-Sending-Domain`; incoming ownership comes only from trusted envelope recipients. Suppression management is an independent Service permission, false by default. Grant changes produce durable signed `service.permissions_changed` events.

`db/migrations/001_initial.sql` is the sole complete application V1 schema. Typed Drizzle definitions under
`src/platform/database/schema` and `pnpm db:generate` regenerate this same file; `pnpm db:check` detects drift.
Keep no incremental patches, application migration journal or old-schema compatibility paths. Initialization accepts
an empty database or validates the identical final V1 by catalog comparison. Tests use uniquely named temporary
databases derived from `TEST_DATABASE_ADMIN_URL`; never use a deployment business database.

The modular monolith uses `src/modules/<business>/{domain,application,infrastructure}`, `public.ts`/`contracts.ts`
module boundaries, `src/platform` infrastructure and `src/integrations/providers` adapters. SQL and Drizzle belong
only in Repositories/ReadRepositories. Application services own transactions through semantic ports and UnitOfWork;
Next controllers and independent Worker processors call public use cases. Next-only authorization facades live in
`src/server` and use `server-only`; shared business code must run in the standalone Worker without Next.js.
Run `pnpm architecture:check`, `pnpm db:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build`.

# Unified callback authentication

A business Service has one callback and one current secret. Send only `x-envoy-id`, `x-envoy-timestamp` and `x-envoy-signature: v1=<hex HMAC-SHA256>`; sign the current Unix-second timestamp, a dot and the original UTF-8 body. Retries preserve event ID/body and re-sign with the current attempt time. Consumers verify one secret with constant-time comparison and a fixed 300-second window, then durably deduplicate event IDs. No secret version, trust set or online secret rotation belongs in this contract. Preserve encryption envelope `key_version` and Service Key rotation, which are separate concerns.

Callback secret replacement is manual: pause, drain in-flight attempts, replace the sole secret on both sides, resume, then replay/reconcile. The backend rejects replacement while active or draining. Pausing keeps live deliveries visible, fences new claims and retains replayable failures. Expired paused attempts are closed by worker recovery. Do not log or return stored secrets; newly generated/replaced values are shown once.


# Bounded sensitive message policy

`POST /messages` accepts generic `sendBefore` (future UTC ISO) and `contentPolicy` (`normal` default or `sensitive`). Sensitive content requires a deadline within 900 seconds. Preserve the exact `messagePolicies` discovery contract in docs/API.md. Envoy never interprets APPs or verification codes. Return existing same-key receipts before time/retention checks; sensitive payload/provider fingerprints are versioned HMACs, whose historical KEKs remain necessary after body purge.

Sensitive free-form content is envelope-encrypted and public/admin columns are redacted. Only send preparation decrypts; no API/admin preview, event, callback, provider-response blob, diagnostic or serialized request copy may expose it. Independent reusable files retain their own lifecycle; callers must keep secrets out of retained email envelopes, opaque IDs/category and reusable files. Provider raw bodies/headers/verified receipts are encrypted for all mail, content-free outbound facts are frozen before association, raw copies are removed after normalization or 900 seconds pending, and normalized replay survives; unknown/inbound classifications keep independent recovery.

Enforce `sendBefore` at acceptance, claim, retry/failover/reconciliation and after asynchronous attachment/credential/DNS/TLS waits at the final HTTP write. Deadline-bound adapters use one bounded HTTPS request and SES uses the same transport after signing, with hidden SDK retries disabled. Expiry before submission records `SEND_DEADLINE_EXCEEDED`/not_accepted; accepted or ambiguous sends retain facts and reconcile without automatic resend. Mandatory worker privacy cleanup runs every 10 seconds independently of optional normal retention and retries object deletion intents. Message `acceptedAt` is local queue acceptance; per-recipient acceptedAt/deliveredAt are nullable real facts, and succeeded means all delivered. The initial V1 is authoritative before launch. Preserve these business guarantees during the architecture refactor; retain no schema compatibility paths or historical migration chain.
