import { afterEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  createAdminSession: vi.fn(),
  deleteAdminSession: vi.fn(),
  getAdminSession: vi.fn(),
  validAdminCredentials: vi.fn(),
  clientIpFromTrustedProxy: vi.fn(),
  enforceScopedRateLimit: vi.fn(),
}));

vi.mock("@/server/admin-auth", () => ({
  createAdminSession: stubs.createAdminSession,
  deleteAdminSession: stubs.deleteAdminSession,
  getAdminSession: stubs.getAdminSession,
  validAdminCredentials: stubs.validAdminCredentials,
}));
vi.mock("@/server/network", () => ({ clientIpFromTrustedProxy: stubs.clientIpFromTrustedProxy }));
vi.mock("@/server/redis", () => ({ enforceScopedRateLimit: stubs.enforceScopedRateLimit }));

import { POST } from "@/app/api/admin/session/route";

afterEach(() => vi.resetAllMocks());

describe("admin login rate limiting", () => {
  it("returns 429 without revealing whether the credentials were close to valid", async () => {
    stubs.validAdminCredentials.mockReturnValue(false);
    stubs.clientIpFromTrustedProxy.mockReturnValue("203.0.113.10");
    stubs.enforceScopedRateLimit.mockResolvedValue(false);

    const response = await POST(new Request("https://envoy.example/api/admin/session", {
      method: "POST",
      body: JSON.stringify({ email: "operator@example.test", password: "wrong-password" }),
      headers: { "content-type": "application/json" }
    }));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ title: "Too many sign-in attempts" });
    expect(response.headers.get("Retry-After")).toBe("900");
    expect(stubs.enforceScopedRateLimit).toHaveBeenCalledTimes(2);
  });

  it("returns the same unauthorized response while attempts remain available", async () => {
    stubs.validAdminCredentials.mockReturnValue(false);
    stubs.clientIpFromTrustedProxy.mockReturnValue(undefined);
    stubs.enforceScopedRateLimit.mockResolvedValue(true);

    const response = await POST(new Request("https://envoy.example/api/admin/session", {
      method: "POST",
      body: JSON.stringify({ email: "operator@example.test", password: "wrong-password" }),
      headers: { "content-type": "application/json" }
    }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ title: "Unauthorized" });
    expect(stubs.enforceScopedRateLimit).toHaveBeenCalledTimes(1);
  });
});
