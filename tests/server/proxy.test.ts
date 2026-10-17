import { describe, expect, it } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config } from "@/proxy";

describe("proxy route matching", () => {
  it.each([
    "/api/admin/actions",
    "/api/admin/export/messages",
    "/api/admin/inbound/example",
    "/api/v1/messages",
    "/api/provider-events/mock/example",
    "/api/health",
  ])("lets API route handlers return their own responses for %s", url => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false);
  });

  it.each(["/", "/providers", "/api-keys"])('protects the dashboard page %s', url => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
  });
});
