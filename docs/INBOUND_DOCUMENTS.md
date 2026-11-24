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

## Original source recovery and reading

The [hosted mail reader](MAIL_READER.md) is the only visual reader and resource preparer. Opening a reading
session automatically resolves retained canonical source, raw MIME or verified original-provider source; no
manual reproject operation is required. Source-less mail exposes only genuinely retained text, never invented
HTML, current logos or guessed attachment/CID associations. Source reconstruction and parsed-image preparation
have independent lifecycles: original source remains under the message retention/erasure boundary, prepared
image bytes belong to the unified reader cache.

New inbound ready copies register their reader manifest in the same transaction as completion. Registration is
metadata-only and does not wait for image HTTP. The worker claims durable bounded image jobs; reading sessions
use the same source/revision/resource identity and prepare ready images first without rescanning mail history.
An existing successful inbound replay does not redispatch messages, generate callbacks or duplicate reader work.

The version-1 passive projection and resource metadata remain message synchronization facts. Its old standalone
image preparation and manual reproject endpoints/orchestration are removed. Migration 008 clears only obsolete
prepared bytes/hash/scan proofs/leases; original source, metadata, messages and callbacks are retained. The hosted
reader compiles a new `mail-reader-v2` document directly from original source; it does not special-case or revive
old tracking/failed resource states.

## Parser dependencies and provider evidence

Direct runtime parser dependencies are `htmlparser2@12.0.0`, `parse-srcset@1.0.2`, `postcss@8.5.28`
(all already present transitively) and newly introduced `postcss-value-parser@4.2.0`. They parse HTML structure,
srcset candidates, stylesheets and declaration values; no browser emulator or arbitrary remote proxy is added.

SendGrid `content-ids` / `attachment-info.content-id` and Mailgun `content-id-map` bind actual multipart part keys,
never attachment filenames; conflicting metadata is not assigned a CID. Original MIME parsing takes precedence
when available. Provider-specific references: [SendGrid inbound fields](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook),
[Mailgun receiving fields](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-http).

## Verification

Run architecture/db checks, typecheck, lint, production build and tests using an explicitly isolated PostgreSQL
admin URL. [MAIL_READER.md](MAIL_READER.md) defines hosted rendering, resource and renewal acceptance. Inbound
integration checks retain separate original HTML/text, atomic ready/manifest registration, same-reader revision
identity, protected CID ownership and cache erasure/revocation; parser/provider checks retain genuine MIME and
part-key CID evidence. No test sends mail or uses deployment data.
