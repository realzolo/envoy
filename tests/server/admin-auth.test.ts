import { describe, expect, it } from "vitest";
import { sessionCookieIsSecure } from "@/server/admin-auth";

describe("admin session cookies", () => {
  it("allows the cookie over a direct HTTP deployment", () => {
    expect(sessionCookieIsSecure(new Request("http://envoy.test/api/admin/session"))).toBe(false);
  });

  it("secures the cookie for a direct HTTPS deployment", () => {
    expect(sessionCookieIsSecure(new Request("https://envoy.test/api/admin/session"))).toBe(true);
  });

  it("uses the browser-facing protocol supplied by a TLS proxy", () => {
    const request = new Request("http://envoy-web:6178/api/admin/session", {
      headers: { "x-forwarded-proto": "https" },
    });

    expect(sessionCookieIsSecure(request)).toBe(true);
  });
});
