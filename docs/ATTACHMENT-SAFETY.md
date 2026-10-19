# Attachment safety contract

Envoy owns attachment storage, optional scanning, quarantine, bounded retry/recovery and use checks for both mail directions.
Callers own their service authorization, business size/type rules, file IDs and business operation IDs. Callers never
connect to a scanner or pass scanner settings to Envoy. A configured `CLAMAV_HOST` selects `require_clean`; when absent,
`integrity_only` permits size/hash-verified files without malware screening. Neither mode permits
unchecked bytes, schema adoption or historical-clean backfill.

## Upload, query, use

`POST /api/v1/files` accepts nonempty private bytes, at most 10,000,000 bytes, and returns **201** after bytes and a durable
task reference are received. No scan network call happens in the request. Every file has its own service-owned fact;
there is no cross-service content deduplication/cache. `GET /files/{id}` returns, for example:

```json
{
  "id": "file_example",
  "fileName": "invoice.pdf",
  "contentType": "application/pdf",
  "size": 123,
  "sha256": "<digest of uploaded bytes>",
  "contentAvailable": true,
  "usage": {
    "state": "processing", "safetyState": "unscanned", "processing": true,
    "canSend": false, "canDownload": false, "reasonCode": "FILE_SCAN_REQUIRED",
    "retryable": true, "recovery": "poll"
  },
  "createdAt": "2026-10-18T00:00:00Z"
}
```

`contentAvailable` means content is logically retained. It does not mean storage is currently reachable, nor that use
is permitted. `usage` is a current policy decision, independent of byte retention:

| Field | Contract |
|---|---|
| `state` | `processing`, `usable`, or `unavailable` |
| `safetyState` | `unscanned`, `pending`, `scanning`, `verified`, `clean`, `malicious`, `unavailable`, `blocked`, or `purged`; `verified` means integrity checked without malware scanning |
| `processing` | Work is active, pending, or eligible for bounded automatic processing |
| `canSend` | Currently safety-approved for outbound use; always false for an inbound attachment |
| `canDownload` | Currently safety-approved for private download |
| `reasonCode` | Nullable stable reason; never an engine response, signature name or scanner address |
| `retryable` | Ordinary automatic processing/polling may still make progress |
| `recovery` | `poll`, `retry` (explicit recovery after repair), or `none` |

Inbound detail attachments return the same `contentAvailable` and `usage`. Body `readyAt`, `inbound.received` and
`inbound.available` mean the sanitized body/metadata became readable, not that each attachment is safe. Poll detail for
attachment progress; there is no per-attachment completion event in the body change feed. Inline/CID images use exactly
the same pipeline, with no separate download bypass. Sanitized HTML does not expose private raw MIME or storage URLs.

| Stable reason | Meaning/action |
|---|---|
| `FILE_SCAN_REQUIRED`, `FILE_SCAN_PENDING` | No applicable proof yet; poll |
| `FILE_VERIFICATION_REQUIRED`, `FILE_VERIFICATION_PENDING` | Integrity-only verification is pending; poll |
| `FILE_POLICY_CHANGED` | A policy changed while work was in flight; retry under the current mode |
| `SCAN_CONFIGURATION_INVALID` | Envoy operator must repair configured scanner settings; caller does not supply them |
| `SCAN_CAPACITY_BUSY`, `SCAN_TIMEOUT`, `SCAN_CONNECTION_FAILED`, `SCAN_CONNECTION_CLOSED`, `SCAN_PROTOCOL_INVALID` | Temporary infrastructure failure, not malware; finite retries, then explicit recovery |
| `FILE_STORAGE_UNAVAILABLE` | Private bytes cannot currently be read; fail closed and recover after repair |
| `SCAN_RETRIES_EXHAUSTED`, `SCAN_TASK_FAILED` | Work exhausted scan/queue recovery; inspect Envoy diagnostics and request controlled reprocessing |
| `FILE_MALICIOUS` | Quarantined, permanently unavailable to ordinary retry |
| `FILE_INTEGRITY_FAILED`, `FILE_SIZE_EXCEEDED` | Bytes fail immutable identity/limit checks; no use permitted |
| `FILE_CONTENT_PURGED` | Erasure tombstone; cannot recover bytes or scan the resource again |
| `FILE_NOT_AVAILABLE` | A send reference is absent or inaccessible; no foreign-resource facts are disclosed |

`POST /messages` only accepts attachments whose `usage.canSend` is currently true. It returns **409 `FILE_NOT_READY`**
while processing and **409 `FILE_UNAVAILABLE`** for unusable/missing references. No message or idempotency acceptance
record is created by that rejection; use the same operation key after polling. A successful idempotent replay of an
already-accepted message returns its original acceptance and does not submit again. Up to 20 attachments and 20,000,000
combined bytes are accepted, with ordinary and inline attachments counted together.

At execution, Envoy rechecks ownership, retention, current safety proof/policy, object existence, byte length and digest
for **every** snapshot before any provider call. Locks prevent erase/reprocess from changing the decision through that
boundary. The current attempt and its wall-clock deadline are checked again after storage preparation, before
transmission; preparation cannot extend an expired submission lease. Queue-time invalidation becomes a determinate
local preparation failure; use the existing message retry API only after repair and only for eligible failures.
Scan completion never retries messages itself. Provider-unknown,
accepted, canceled and uncertain submissions retain their existing protections; an unknown result is never auto-resent.

`GET /files/{id}/download` and `GET /inbound-messages/{id}/attachments/{attachmentId}` apply the same proof/byte checks,
return attachment disposition, `nosniff`, private no-store and a sandbox policy. A foreign resource returns 404;
unapproved owned content returns 409. Observed byte corruption is quarantined and cannot use another object's proof.
There are no permanent public URLs or object keys in these contracts.

## Retry, erasure and operations

`POST /files/{id}/reprocess` and `POST /inbound-messages/{id}/attachments/{attachmentId}/reprocess` use the service key,
return **202 `{id,processing:true}`**, and audit a new processing request. Live queued/leased work is reused. Temporary
failures can be retried after repair; clean retained content may be deliberately reprocessed, revoking use until the
new result. Malicious, integrity-blocked and purged resources reject recovery with `FILE_UNAVAILABLE` and
`FILE_REPROCESSING_FORBIDDEN`. Recovery does not weaken ownership or initiate mail delivery.

Task metadata and outbox publication are durable in PostgreSQL, using the existing BullMQ PostgreSQL backend. A fair
persistent scope rotation queues at most one live task per service at a time. Lost jobs/expired dispatch leases can be
reissued; random scan lease tokens fence stale completions. Five scan claims and exponential 30–600 second backoff
bound automatic processing. A claim that dies on its fifth attempt becomes exhausted rather than looping forever.
Engine absence, errors and malformed responses remain distinct from a malicious verdict in `require_clean` mode.

The shared scanner has a 10 MB limit, bounded process concurrency, a 4096-byte response cap and a single total deadline
covering connect, writes/backpressure and response. It parses the exact NUL-terminated INSTREAM result, never searches
for an `OK` substring. Connections and capacity are released on every outcome; raw engine/signature text is discarded.
Object reads are bounded too. Proofs bind expected/processed SHA-256 and the applicable mode-separated policy version.
In `integrity_only`, the Worker still reads the stored object and checks size and SHA-256, then records `verified` without
connecting to a scanner. Switching back to `require_clean` invalidates these proofs and schedules retained files for scanning.
Known malicious or integrity-blocked files remain unavailable in either mode.
Wire framing and deployment limits follow the official [ClamD protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html);
the client uses one framed INSTREAM command per connection and does not enable sessions or filesystem-path commands.

Content DELETE uses the existing owner authorization, shared-reference checks, durable deletion intents and tombstones.
Purging an in-progress scan fences its late result; no scan job writes object content. Accepted/active/unknown messages
still protect their snapshots. Downloads authorized/copied before a purge may complete; later reads are denied. The
existing retention/object cleanup also reclaims isolated/quarantined, unreferenced and failed-upload objects. Retention
and explicit deletion remain separate from temporary scan failure and recovery. Backups and caller copies are separate.

The **Attachment Safety** admin page shows configuration, status counts, observed times, failure codes, task attempts
and allowed reprocessing. Configuration and past observations do not guarantee current scanner health. Mode, scanner host,
port, timeout, concurrency and policy version belong only in Envoy deployment configuration; leave `CLAMAV_HOST` unset
on both Web and Worker to disable scanning, or configure it on both to require clean results; see
[Operations](OPERATIONS.md#attachment-safety-operations). All instances must switch policies together with admission and
sending workers stopped/drained. No mixed-policy rolling deployment or automatic history resend is supported.

Executed SQL migrations are immutable and changes append ordered versions with checksums. `pnpm db:setup` applies
missing versions under a transaction lock after catalog verification. `pnpm db:generate` updates the typed
`db/schema.sql` snapshot; `pnpm db:check` validates it and migration checksums. Setup rejects drift and preserves
business records in future ordered upgrades. Unverified bytes are never backfilled clean.

## Minimal business flow

Configure only Envoy URL, service key and an authorized business sender. The runnable
[attachment example](../examples/attachment-mail.mjs) implements these calls:

```bash
node examples/attachment-mail.mjs upload ./invoice.pdf
# Save the returned file ID with your business operation.
node examples/attachment-mail.mjs status file_example
# Wait/poll until usage.canSend=true; honor service rate limits and bounded backoff.
node examples/attachment-mail.mjs send file_example order-123 customer@example.net
```

The send command uses the supplied stable operation ID for idempotency. Reuse that operation/file ID pair on retry;
do not upload again for each polling or send attempt. `FILE_NOT_READY` is not an accepted message and never implies
provider transmission. A successful send acceptance still means queued, not actual delivery.

## Morph/Sonaops integration adjustment checklist

1. **Cutover prerequisite:** implement and verify this Envoy capability, deploy it to the target environment, run its
   worker, and verify actual target upload → pending → approved → usable plus fail-closed behavior. Under `require_clean`,
   approved means `clean` from a real scanner; under `integrity_only`, it means `verified` by size/hash checks only. Keep the existing business checks until this
   prerequisite is met; do not create a safety-check gap.
2. Keep business APP/service binding, permissions and business file size/type restrictions. Replace local scanner
   execution with private Envoy upload and durable storage of the returned `fileId` under the original operation ID.
3. Query Envoy `usage`; show processing/usable/unavailable. Send only when `canSend` is true, download only when
   `canDownload` is true, and handle authoritative 409 rejections after queue/policy changes. Keep operation IDs stable.
4. Remove the business scanner client, ClamAV/network dependency, local scan queue/cron/retry tasks and their local
   clean-result authority **after** the target capability is accepted. Remove the three business scanner settings:
   scanner **host**, **port**, and **timeout** (using each project's actual setting names). None become Envoy request
   fields. Envoy operators own their corresponding deployment settings and scanner lifecycle.
5. Use service-owned reprocess endpoints only for recoverable failures, and content DELETE for the business lifecycle.
   Never release malicious/blocked/purged content, turn a timeout into clean, or resend an unknown mail after a scan.
6. Retain normal service isolation, mail idempotency, status/event consumption and business authorization. If Envoy
   safety is unavailable during cutover, hold attachment use and repair Envoy; do not silently restore an unchecked
   path. Remove scanner infrastructure from the business deployment only after those safety gates are proven.

Outbound uploads require `X-Sending-Domain`, freezing the Service-authorized From domain. Files cannot be attached across domains. Removed Service-domain bindings block file metadata, reprocessing, downloads and erasure through the service API. `examples/attachment-mail.mjs` takes `ENVOY_SENDING_DOMAIN`.
