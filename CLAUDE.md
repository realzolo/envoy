@AGENTS.md

# Business mail architecture

Read `docs/ARCHITECTURE.md` and `docs/API.md` for the final domain-permission contract. Envoy owns business Service identities, rotating Service Keys, domain sending/receiving grants and one unified callback per Service. Business APPs, exact mailbox purposes, templates and APP dispatch belong to callers.

`service_domain_grants` is the sole business mail authorization authority. Never reintroduce Product-inherited or exact-address sender grants, mailbox ACLs, per-route callbacks or business APP fields. Every protected resource and background network operation must check ownership and current frozen domain permissions, including after storage or DNS waits at the final network boundary. Files require `X-Sending-Domain`; incoming ownership comes only from trusted envelope recipients. Suppression management is an independent Service permission, false by default. Grant changes produce durable signed `service.permissions_changed` events.

Migration `002_service_domain_permissions.sql` directly replaces the obsolete model and explicitly refuses nonempty development mail business tables, routes without a Service or duplicate Service callbacks. The user authorized revising the initial migration for this pre-launch project: callback_endpoints contains one encrypted current secret and no signing-version column. Do not add runtime compatibility branches, reset data or bypass checksum checks on an existing database. Run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build`. The test suite creates/drops only its dedicated local `envoy_test` database; it must never use a deployment business database. No dependencies or versions change for this model.

# Unified callback authentication

A business Service has one callback and one current secret. Send only `x-envoy-id`, `x-envoy-timestamp` and `x-envoy-signature: v1=<hex HMAC-SHA256>`; sign the current Unix-second timestamp, a dot and the original UTF-8 body. Retries preserve event ID/body and re-sign with the current attempt time. Consumers verify one secret with constant-time comparison and a fixed 300-second window, then durably deduplicate event IDs. No secret version, trust set or online secret rotation belongs in this contract. Preserve encryption envelope `key_version` and Service Key rotation, which are separate concerns.

Callback secret replacement is manual: pause, drain in-flight attempts, replace the sole secret on both sides, resume, then replay/reconcile. The backend rejects replacement while active or draining. Pausing keeps live deliveries visible, fences new claims and retains replayable failures. Expired paused attempts are closed by worker recovery. Do not log or return stored secrets; newly generated/replaced values are shown once.
