# Passive inbound reading projections

Envoy owns MIME/provider decoding, provenance, safe passive HTML/CSS, the resource manifest and source-based
reprojection. Business callers own their non-lossy private projections and authorization; reading applications own
isolated rendering and user controls. Document APIs never interpret business APPs, reroute mail or send callbacks.

## Contract and lifetime

`GET /api/v1/inbound-messages/{id}` adds nullable `document`. The canonical finite wire shape is in
`src/modules/inbound/contracts.ts` and [the JSON schema](contracts/inbound-document.schema.json). Version 1 uses
`policyVersion: mail-passive-v1`, decimal-string `revision`, SHA-256 `sourceDigest` or null, `primaryRepresentation`
(`HTML`, `TEXT`, `NONE`), independent `textProvenance` (`AUTHORED`, `DERIVED`, `NOT_RECORDED`, `UNAVAILABLE`),
`state` (`CURRENT`, `PARTIAL`, `SOURCE_UNAVAILABLE`) and at most 64 resources. Projection metadata is explicitly
whitelisted at public reads. Lists and callbacks contain no document, image bytes or source URLs.

`CURRENT` means the retained source was projected under this policy. It does not promise every modern CSS feature
or exact native mail-client rendering. `PARTIAL` records known missing/blocked resources, parsing or byte-budget
loss; source loss is separately `SOURCE_UNAVAILABLE`. Source-less historical repair never claims original HTML
restoration: HTML is null and residual text is labelled `NOT_RECORDED`, or `UNAVAILABLE` when absent. HTML and
text are individually limited to 2,000,000 UTF-8 bytes; truncated text retains code-point boundaries and marks partial.
NUL and lone Unicode surrogates become explicit U+FFFD in the public projection and mark it partial; encrypted
source remains unchanged. This prevents PostgreSQL text/JSONB failures without silently removing author text.
A sanitized empty HTML shell cannot outrank readable text. Unready copies expose metadata without body content.

The manifest freezes `id`, `kind` (`CID`, `EMBEDDED`, `REMOTE`), canonical case-sensitive `contentId` and original
`attachmentId`. IDs use `[A-Za-z0-9_-]{1,200}` and are unpredictable. State, verified MIME/size and eligibility can
change at the same document revision as independent resource preparation finishes. States are `READY`,
`PREPARING`, `RETRYABLE`, `BLOCKED`, `UNAVAILABLE`, `ERASED`. Reasons are the finite schema enum, never provider
text, arbitrary URLs or exception messages. `downloadEligible` means the current Service can attempt Envoy's
fixed resource read; caller scope, private-copy readiness and local safety approval remain independent.

V6 appends `document_revision`, envelope-encrypted canonical `document_source`, safe `document_projection` and
`inbound_document_resources`. Cache bytes and resource source URLs/data are separately envelope encrypted with
resource-specific AAD; they are not public object links. Original inbound content retention and content DELETE
atomically erase canonical source, document metadata, source URLs, cache bytes and CID content references. The
parent purge trigger also fences late body updates. No document-specific longer retention exists.

## Passive HTML and CSS

Provider original HTML remains HTML. MIME parsing disables HTML-to-text, text-to-HTML and CID-to-data-URI
conversion. HTML-only MIME can yield an empty mailparser text sentinel; it is treated as absent, never as an authored
plain-text representation. Provider text fields remain separate without guessing their origin: actual MIME text/plain is `AUTHORED`;
provider-projected text with no MIME evidence is `NOT_RECORDED` (Mailgun can synthesize body-plain from HTML). No bare body base64 is
inferred to be an image, and text is never guessed into tables/buttons.

Sanitize-html owns markup/attribute safety; PostCSS and its value parser own declarations and URL functions.
A structural HTML parser locates actual style nodes because sanitize-html emits style raw text without its ordinary
text hook. This CSS pass finishes before anything is persisted/read. Tables, spans, classes, IDs, colspan/rowspan,
cell spacing/padding, dimensions, typography, colors, borders, background images and a bounded responsive media
subset survive. Allowed properties/functions are explicit in `domain/document.ts`. Script, forms, iframe, active
SVG, event handlers, base/link/meta navigation, font downloads, imports, animations, fixed positioning, CSS
expressions/behavior/custom-property indirection and unsupported CSS functions/rules are removed. One unsafe
or escaped URL declaration does not discard unrelated safe styling. This is not a general browser/CSS emulator.

Every `img` source, srcset candidate, legacy background attribute and allowed CSS `url()` becomes a declared
`mail-resource:<id>`. Srcset-only images retain a controlled fallback. CID references percent-decode only at lookup,
strip complete outer angle brackets, preserve case, and require one actual same-message attachment with matching
CID; duplicate/missing CID is unavailable. Filenames never establish CID ownership. Explicit bitmap data URIs in
resource positions become encrypted resources. Author-written literal URLs, data strings and encoded text are not
rewritten or removed. Links remain safe explicit user navigation; consumers must display/intercept them safely.
Explicit `blockquote type="cite"` is retained as passive quoted-reply provenance; other `type` values are removed.
Sender-authored attachment placeholders such as `<span id="cid:logo">&lt;app-logo.png&gt;</span>` remain literal text:
an element ID or filename is not an image reference, MIME part or downloadable attachment. A reply which does not
reattach original files must not obtain synthetic attachments or a current logo substituted into historical content.

## Protected resource preparation

`GET /api/v1/inbound-messages/{id}/document-resources/{resourceId}` resolves only a server-owned manifest row for
that original message's current document revision and Service. It returns a raster response with verified MIME,
byte length, hexadecimal `X-Content-SHA256`, no-store, nosniff and sandbox headers. No query accepts a raw URL.
CID uses the existing protected attachment read, its byte digest, scanner and current full-envelope authorization.
Remote/embedded images are byte-identified and checked against current scanner policy before encrypted caching.
`require_clean` accepts clean only; `integrity_only` accepts verified only. Scanner changes reverify retained cache
bytes instead of contacting the sender again, and invalidate the prior cache proof.

Limits are 5,000,000 bytes/image, 16,000,000 canvas pixels, 16,384 pixels/edge, 20,000,000 cached bytes/document,
64 manifest entries and three concurrent media preparations/process. Only PNG/JPEG/GIF/WebP are supported; SVG
and AVIF are not accepted. These bitmap bounds are independent of the reusable outbound attachment contract.
Each preparation is leased; transient failures wait at least 30 seconds, and after three attempts wait five minutes
before a new demand can start a budget. There is no automatic media poller or history scan.

Remote reads accept only HTTP(S) on standard ports without URL credentials; every DNS answer must be public.
IPv4/IPv6 local, private, loopback, link-local, reserved and transition ranges are rejected independently of any
private-callback development override. Resolved addresses are pinned. At most three redirects are followed, with
fresh DNS/address/permission checks at every hop. One 10-second wall-clock budget covers even unresolved DNS,
TLS, authorization and response. Responses have byte limits, no decompression, cookies, authorization or Referer.
The current original Service and **all** frozen private envelope domains are rechecked at the last HTTP write after
DNS/TLS waits and again before cache publication/byte return. Parent erasure and document CAS/lease checks fence
late results. Resource IDs or cached bytes from another Service, revision or erased copy cannot be read.

Identified 1x1 remote images default to `BLOCKED/TRACKING_RISK`; explicit `allowTracking=true` is the only opt-in
for that resource. Cache use does not promise anonymity: the first allowed fetch can still disclose a tracking hit
or a sender-specific URL. Unknown tracking cannot be reliably identified. Consumers must keep iframe CSP from
fetching arbitrary images/fonts even if their display feature supports safe resource replacement.

## Bounded historical reprojection

`POST /api/v1/inbound-messages/{id}/document-reprojection` takes the observed decimal-string expectedRevision.
Legacy copies start at zero. The application rechecks original ownership, obtains a real retained source outside
the write transaction, rebuilds the current safe document and publishes via locked CAS. At most two such repairs
run concurrently/process. Repeating the current policy/current revision is idempotent; stale revisions conflict.
The original inbound ID, Service, provider external ID, envelope, attachments, status/ready time, callbacks and change
stream remain unchanged. An audit stores only old/new revision and resource identity, without body/source URLs.
Ordinary ready-copy replay is intentionally unchanged; this is an independent read-projection operation.

Source priority is encrypted canonical source, retained private raw MIME, then retained verified provider receipt.
Postmark/SendGrid/Mailgun receipts can contain the original HTML/text or MIME. Resend uses only its fixed native
received-message GET for the original stored provider account/external ID, with original-copy authorization and
current provider credential rechecked after TLS immediately before writing. It fetches no attachments, follows no
redirects and can use that frozen copy identity even when the earlier webhook receipt expired. Provider 404/410 is
source unavailable; transient storage/provider errors defer instead of falsely claiming the source was lost.
No raw MIME/verified receipt endpoint is exposed. No current logo substitutes for historical content.

Callers request old repair on actual reading demand, apply their own persistent audit/lease/CAS, finite backoff,
small shared recovery budgets and resumable markers. Do not scan all history or reproject at second-scale polling.
Sources erased or no longer retained cannot reconstruct original tables, images or styling; readable residual text
is kept honestly and no broader grant or current routing decision can repair a revoked private copy.

## Parser dependencies and provider evidence

Direct runtime parser dependencies are `htmlparser2@12.0.0`, `parse-srcset@1.0.2`, `postcss@8.5.28`
(all already present transitively) and newly introduced `postcss-value-parser@4.2.0`. They parse HTML structure,
srcset candidates, stylesheets and declaration values; no browser emulator or arbitrary remote proxy is added.

SendGrid `content-ids` / `attachment-info.content-id` and Mailgun `content-id-map` bind actual multipart part keys,
never attachment filenames; conflicting metadata is not assigned a CID. Original MIME parsing takes precedence
when available. Provider-specific references: [SendGrid inbound fields](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook),
[Mailgun receiving fields](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-http).

## Verification

Run `pnpm architecture:check`, `pnpm db:check`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`.
Run `TEST_DATABASE_ADMIN_URL=<isolated-local-admin-url> pnpm test` against a disposable PostgreSQL instance;
the runner creates and drops uniquely named databases. Database suites allow 30 seconds per full catalog case.
They cover empty setup, V5 legacy body preservation with revision zero, complete V6 rollback/retry, repeated
validation and checksum/catalog drift refusal. Document cases exercise genuine retained MIME, source-less
fallback, original provider identity without a receipt, late revocation, source erasure and encrypted image caches.
Provider cases use real MIME and explicit part-key CID maps; network tests use isolated transports and do not send mail.
