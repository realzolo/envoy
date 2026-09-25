import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionCookieIsSecure, validAdminCredentials } from "@/server/admin-auth";

afterEach(() => vi.unstubAllEnvs());

describe("admin session cookies", () => {
  it("allows the cookie over a direct HTTP deployment", () => {
    vi.stubEnv("ENVOY_TRUST_PROXY", "");
    expect(sessionCookieIsSecure(new Request("http://envoy.test/api/admin/session"))).toBe(false);
  });

  it("secures the cookie for a direct HTTPS deployment", () => {
    expect(sessionCookieIsSecure(new Request("https://envoy.test/api/admin/session"))).toBe(true);
  });

  it("uses the browser-facing protocol supplied by a TLS proxy", () => {
    vi.stubEnv("ENVOY_TRUST_PROXY", "true");
    const request = new Request("http://envoy-web:6178/api/admin/session", {
      headers: { "x-forwarded-proto": "https" },
    });

    expect(sessionCookieIsSecure(request)).toBe(true);
  });

  it("does not trust a forwarded protocol from a direct client", () => {
    vi.stubEnv("ENVOY_TRUST_PROXY", "");
    const request = new Request("http://envoy.test/api/admin/session", {
      headers: { "x-forwarded-proto": "https" },
    });

    expect(sessionCookieIsSecure(request)).toBe(false);
  });

  it("fails closed when administrator credentials are not configured", () => {
    vi.stubEnv("ENVOY_ADMIN_EMAIL", "");
    vi.stubEnv("ENVOY_ADMIN_PASSWORD", "");

    expect(validAdminCredentials("admin@envoy.local", "envoy")).toBe(false);
  });

  it("uses only explicitly configured administrator credentials", () => {
    vi.stubEnv("ENVOY_ADMIN_EMAIL", "operator@example.test");
    vi.stubEnv("ENVOY_ADMIN_PASSWORD", "test-password");

    expect(validAdminCredentials("operator@example.test", "test-password")).toBe(true);
    expect(validAdminCredentials(" OPERATOR@example.test ", "test-password")).toBe(true);
    expect(validAdminCredentials("operator@example.test", "wrong-password")).toBe(false);
  });
});
