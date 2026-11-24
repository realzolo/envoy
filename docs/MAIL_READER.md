# Unified hosted mail reader

Envoy owns the only HTML compiler, original-source resolution, image preparation and durable content cache used by
its inbound/outbound administration screens and by business callers. React/Vue hosts embed the issued reader URL;
they do not rewrite HTML, classify tracking images, fetch private image copies or apply a second CSS sanitizer.
`mail-reader-v2` is independent of the retained `mail-passive-v1` message-fact projection. No old failure-state
exceptions, guessed logos, legacy HTML reconstruction or per-sender branches are part of the reader.

## Session contract

Authenticated Service operations:

- `POST /api/v1/inbound-messages/{id}/reading-session`, empty JSON object.
- `POST /api/v1/messages/{id}/reading-session`, JSON `{ "recipient": "exact original recipient" }`. The exact
  Service/message/recipient must identify one delivery; the server never selects the first recipient.

Administrator operations, after administrator-session authentication:

- `POST /api/admin/inbound/{id}/reading-session`.
- `POST /api/admin/deliveries/{id}/reading-session`.

All return `{ url, expiresAt, documentRevision, channelId }`. `url` is an absolute HTTPS URL under the configured
`ENVOY_PUBLIC_URL` origin and fixed `/mail-reader/{opaque}` path. Production requires that origin setting;
development may use the request origin. The opaque token is an authenticated encrypted capability, not a Service
Key or administrator cookie. It binds one source, observed source revision and original Service authority (or
administrator authority); it expires after 120 seconds. The independent random 128-bit `channelId` is for iframe
message correlation and never grants content access. Descriptors are private/no-store and must not be persisted.

`documentRevision` is a SHA-256 digest of the exact source/attachment facts and reader policy. It is not the decimal
revision of `mail-passive-v1`. A new renderer policy produces a new derived artifact from retained original source,
without changing the original mail, business conversation, routing, send state or notifications.

Capability endpoints are `GET /mail-reader/{opaque}`, `GET /mail-reader/{opaque}/status` and
`GET /mail-reader/{opaque}/resources/{resourceId}`. Every use verifies expiry and current source retention and
Service/full-envelope domain authority. Resource reads recheck before/after external work and publication. No
Service Key is sent to a browser; no administrator cookie is needed inside the iframe. Resource/status responses
allow anonymous-origin CORS for the exact capability and never include cookies.

Finite failures: `404 READING_UNAVAILABLE` for unavailable authority/source identity; `410 READING_SESSION_EXPIRED`;
`409 READING_SOURCE_PENDING` for temporary original-source preparation; resource 404/409 with
`READING_RESOURCE_UNAVAILABLE`, `READING_RESOURCE_UNSUPPORTED`, `READING_RESOURCE_LIMIT`, `READING_FETCH_FAILED`.
A terminal resource failure is reported per resource instead of leaving the document permanently “preparing”.

## Intermediary transformations

A rendered mail is a retained content artifact. Every reader response sends
`Cache-Control: private, no-store, no-transform`; the HTML renderer also encloses the complete document in
`<!--email_off-->` / `<!--/email_off-->` comments. These are delivery directives, not substitutions in the retained
mail. The Cloudflare [Email Address Obfuscation contract](https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/)
explicitly supports both exclusions. Otherwise its HTML rewrite may replace visible email addresses with
`[email protected]` and inject a decoding script that the reader's nonce-only CSP correctly refuses to execute.
The CSP is not relaxed to accommodate scripts inserted by an intermediary.

The deployment endpoint rule for `/mail-reader/*` should preserve the response artifact and disable Email Address
Obfuscation and other HTML/script rewriting on that path. Cloudflare documents the endpoint-specific setting in
[Configuration Rules](https://developers.cloudflare.com/rules/configuration-rules/settings/#email-obfuscation).
The application headers and comments do not change a deployed edge rule or override a custom Worker that rewrites
responses; such infrastructure changes follow the deployment owner's release procedure.

To diagnose a deployed mail, distinguish the retained source, the origin reader response, and the edge response.
An original address in the source/origin but `__cf_email__`, `data-cfemail`, `/cdn-cgi/l/email-protection` or an added
`email-decode.min.js` in the edge HTML identifies a delivery transformation. If the original retained source
already contains those markers, delivery exclusions do not reconstruct it: restoration must use the actual
original MIME/provider source. The reader never reverse-decodes or replaces authored body text to conceal the
problem. Plain-text JSON and rendered HTML following different edge processing paths can explain a normal address
in the text panel alongside a protected address in the HTML panel.

## Original source and fidelity

Inbound source order is retained canonical authored HTML/text, original raw MIME, then the verified retained
provider receipt/fixed original provider identity. Opening a reading session performs this recovery automatically;
there is no manual “restore original layout” action. Successfully recovered source is saved as encrypted canonical
source under the original retention/erasure boundary. Old sanitized HTML is never treated as original source.
When no original HTML remains, only the actually retained text can be displayed; no invented table or image is added.
Outbound uses the original accepted message body and attachment snapshot for the precise delivery.

The generated text-only document preserves exact text, paragraph breaks and literal addresses, uses a readable
neutral presentation, and wraps long lines and URLs within the available frame width. These generated text styles
are applied only when the HTML part is absent or blank; an authored HTML document retains its own typography.
Literal filenames or Apple Mail CID placeholder spans without an actual image element or retained same-message
attachment are source facts, not recoverable images. Do not infer a replacement from a filename or another mail.

The compiler preserves the original document/body/style cascade, CSS variables and responsive rules, tables,
backgrounds, inline dimensions and authored colors. An iframe isolates host application styling. The host adds no
dark-mode transformation or typography override. Scripts/event handlers and embedded active frames are not email
presentation and are excluded; only Envoy's nonce-bound native `/mail-reader/runtime.v2.js` resize/status runtime executes. This asset is served unchanged, not serialized from compiled TypeScript functions.

CID references bind an exact same-message attachment Content-ID, retaining case and rejecting ambiguous matches.
Embedded images, HTTPS/HTTP images, `srcset`, CSS `url()` and legacy background attributes are resolved into the same
resource graph. All remote images, including 1×1 images, load by default; privacy/tracking classification does not
suppress them. Native PNG/JPEG/GIF/WebP/AVIF/SVG bytes are preserved; animated images are not flattened. Remote
font/style references are retained as CSS presentation dependencies. Images are limited to 20 MB each and the
prepared image cache to 100 MB per document; source and resource budgets are operational bounds, not hidden
privacy policies. Remote HTTP has a bounded timeout, redirect/DNS checks and bounded gzip/deflate/Brotli decoding.

## Preparation and status

New inbound copies enqueue their reader manifest atomically in the ready-copy transaction, without external HTTP. Issuing a session uses the same durable manifest identity. Worker preparations and live resource reads share the
same exact source/revision/resource cache identity and lease. The cache stores encrypted verified bytes and MIME,
size and SHA-256 separately from the short browser capability. Closing a reader or renewing its capability does
not discard successfully prepared bytes. Parent erasure deletes cached resources and fences late publishers.

State is aggregated over all manifest resources: `PENDING`, `RUNNING`, `READY`, `RETRY_WAIT`, `UNAVAILABLE`.
`READY` requires byte content, MIME, size and digest. Status reads select metadata only and do not fetch external
images. Status includes total/ready/active/failed counts, a status revision and nextCheckAt; resource facts include nextRetryAt. The iframe reads status at the suggested bounded interval while work is incomplete, updates individual image/CSS resource slots
in place and stops polling when every resource is terminal. It does not rebuild the entire HTML document.

## Host messages and renewal

Hosts use `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"` without `allow-same-origin`,
`referrerpolicy="no-referrer"`, validate `event.source === iframe.contentWindow` and the active `channelId`.
Opaque iframe origins are expected; the channel/source checks are authoritative for layout messages.

Runtime messages: `envoy:mail-reader:layout` with `height`, `envoy:mail-reader:ready` with resource statuses,
`envoy:mail-reader:expired`, and `envoy:mail-reader:unavailable`, each with `channelId`.
Layout height follows actual body, rendered descendant boxes and text bounds, including nested positioned paint,
ancestor overflow clipping, padding, margins and horizontal scrollbar space. It must not use the root scroll height as a minimum: that value is floored by the existing iframe
viewport and would prevent the host from shrinking after content or width changes. The runtime observes body/root
size changes, image loads and viewport resizing so wrapped text and asynchronously prepared resources resize the host.
Hosts renew through the original authenticated POST 30 seconds before expiry. For an unchanged document revision,
they send `{ type: "envoy:mail-reader:renew", channelId: oldChannelId, session: newDescriptor }` to the existing
frame. The frame checks parent/channel, switches its own capability/channel and resource URLs, and retains DOM and
scroll state. A changed source revision starts a new reader document.
An explicit host message `{type:"envoy:mail-reader:retry",channelId,operationId}` invokes
`POST /mail-reader/{opaque}/retry` with JSON `{operationId}`. This operation rechecks source authority, appends
one idempotent retry audit and starts a new attempt budget only for failed resources. Ordinary status, session
renewal and reopening do not reset failed resource attempts. Retry POST has anonymous-origin CORS preflight support. Closing or changing mail cancels host HTTP
and renewal timers; delayed responses cannot replace the current message.

## Validation and rollout

Deploy Envoy's new ordered cache migration before matching Web/Worker, then matching Morph and Sonaops reading
session clients. Set `ENVOY_PUBLIC_URL` to the actual HTTPS Envoy origin. Original message IDs, routing and send
facts are not migrated or replayed. Old independent administrator preview endpoints/components are retired.
Run architecture/db checks, typecheck, lint, unit/integration tests in an isolated database, and production build.
Use real retained Google/AppBrain/Stripe source samples to compare both hosts: complete logo/background/image
counts, matching table/color/size layout, GIF animation, AVIF/SVG, CID ownership and missing-source behavior.
Verify renewal, partial failures, three-way concurrent preparation, expiry/revocation/erasure and late publications.
Local compilation or synthetic fixtures do not prove a deployed provider/image origin is available.
