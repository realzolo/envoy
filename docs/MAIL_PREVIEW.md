# Outbound message previews

The delivery detail page reads a passive projection through authenticated admin endpoints. The accepted HTML,
attachment snapshot and provider submission are unchanged. No database migration or attachment backfill is needed.

`GET /api/admin/deliveries/{id}/preview` returns sanitized HTML and a resource manifest. Every image source,
srcset candidate and CSS background becomes an opaque `mail-resource` reference. The pure projection, bitmap
validation and restricted HTTP transport are shared with inbound documents; inbound wire formats remain unchanged.

`GET /api/admin/deliveries/{id}/preview/{resourceId}?revision={revision}` reads only resources declared by that
delivery's retained, normal-content message. The revision binds the message, service, original HTML and immutable
attachment references. Both endpoints require an admin session and current sending-domain access. Images never
accept a caller-supplied URL, filename or storage key. Sensitive and erased content is unavailable.

CID matching preserves case, decodes URL escapes and requires a unique inline attachment with the same Content-ID.
The existing protected attachment reader checks ownership, retention, current scanner policy and stored-byte
integrity. The preview also verifies bytes against the accepted attachment snapshot. Missing, ambiguous, rejected,
changed or unavailable attachments produce an explicit unavailable-image notice with a manual retry.

Remote images remain hidden until the user chooses **Load remote images**. Consent belongs to the current delivery
and resets on navigation. A same-origin custom request header carries that choice; a query string cannot enable it.
The proxy sends no ambient credentials, cookies or Referer. It pins public DNS answers, validates redirects, blocks
private/reserved addresses, limits redirects and enforces an overall deadline. Consent includes tracking pixels;
the UI explains that a fetch may notify the sender. Embedded and remote bytes must pass current scan policy.

Only byte-identified PNG/JPEG/GIF/WebP images are served. The shared limits are 5 MB/image, 16 million pixels,
16,384 pixels/edge and 64 manifest resources. The UI retains at most 20 MB of image bytes and fetches up to three
images concurrently; resource preparation is also limited to three concurrent requests per server process.

The parent fetches protected bytes, verifies browser decoding, and creates bounded bitmap data URIs for an opaque
sandboxed iframe. Parent-origin blob URLs cannot be relied on inside that sandbox. Its CSP permits only data images
and passive inline styles; scripts, arbitrary network access, fonts, forms and navigation
metadata are removed or blocked. Resource replacement is structural, preserving literal sender text and links.
Responses use private/no-store, verified raster MIME, nosniff and sandbox headers. Ownership/revision and scanner
policy are checked again after asynchronous I/O. Unmounting, switching delivery, changing consent or retrying
aborts old requests and releases the previous preview. Preview resources are never persisted in a separate cache.

Verification covers CID matching, snapshot integrity, authentication, revocation, erasure, scan policy, remote
consent, SSRF policy, HTML/CSS fidelity and text preservation. Integration fixtures use disposable databases and
their own stored images.
