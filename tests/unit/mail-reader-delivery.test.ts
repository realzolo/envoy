import { describe, expect, it } from "vitest";
import { renderReader } from "@/modules/mail-reader/domain/frame";
import type { ReaderGrant } from "@/modules/mail-reader/application/service";

const grant: ReaderGrant = {
  kind: "INBOUND",
  id: "inb_test",
  serviceId: "svc_test",
  revision: "a".repeat(64),
  channelId: "b".repeat(32),
  expiresAt: 2_000_000
};

function render(html: string) {
  return renderReader({ html, resources: [] }, "opaque", grant, "https://envoy.test", "nonce");
}

describe("mail artifact delivery boundaries", () => {
  it("excludes the complete HTML artifact from edge email-address obfuscation without altering email text or links", () => {
    const html = render('<html><head><style>body{color:#123}</style></head><body><p>test.envoy@sonaops.space</p><a href="mailto:test.envoy@sonaops.space">Contact</a></body></html>');
    expect(html.startsWith("<!doctype html><!--email_off-->")).toBe(true);
    expect(html.endsWith("<!--/email_off-->")).toBe(true);
    expect(html).toContain("<p>test.envoy@sonaops.space</p>");
    expect(html).toContain('href="mailto:test.envoy@sonaops.space"');
    expect(html).toContain("body{color:#123}");
    expect(html).toContain("script-src 'nonce-nonce'");
    expect(html).not.toContain("email-decode.min.js");
    expect(html.indexOf("<!--email_off-->")).toBeLessThan(html.indexOf("<html>"));
    expect(html.lastIndexOf("<!--/email_off-->")).toBeGreaterThan(html.lastIndexOf("</html>"));
  });

  it("preserves obfuscation already present in a retained source instead of guessing or decoding authored content", () => {
    const original = '<p><a class="__cf_email__" data-cfemail="deadbeef" href="/cdn-cgi/l/email-protection">[email protected]</a></p>';
    const html = render(original);
    expect(html).toContain(original);
    expect(html).toContain('data-cfemail="deadbeef"');
    expect(html).not.toContain("email-decode.min.js");
  });
});
