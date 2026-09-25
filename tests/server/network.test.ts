import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIpFromTrustedProxy } from "@/server/network";

afterEach(() => vi.unstubAllEnvs());

describe("trusted proxy client addresses", () => {
  it("does not consume client-supplied forwarding headers by default", () => {
    vi.stubEnv("ENVOY_TRUST_PROXY", "");
    const request = new Request("https://envoy.test/api/provider-events/postmark/token", {
      headers: { "x-forwarded-for": "203.0.113.10" }
    });

    expect(clientIpFromTrustedProxy(request)).toBeUndefined();
  });

  it("accepts a valid client address only when a trusted proxy is explicitly enabled", () => {
    vi.stubEnv("ENVOY_TRUST_PROXY", "true");
    const request = new Request("https://envoy.test/api/provider-events/postmark/token", {
      headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.4" }
    });

    expect(clientIpFromTrustedProxy(request)).toBe("203.0.113.10");
  });

  it("rejects malformed forwarded addresses", () => {
    vi.stubEnv("ENVOY_TRUST_PROXY", "true");
    const request = new Request("https://envoy.test/api/provider-events/postmark/token", {
      headers: { "x-forwarded-for": "not-an-ip" }
    });

    expect(clientIpFromTrustedProxy(request)).toBeUndefined();
  });
});
