import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  body: {} as Record<string, unknown>,
  createDomain: vi.fn(),
}));
vi.mock("@/server/admin-mutation", () => ({
  adminMutation: (_request: Request, execute: (body: Record<string, unknown>, actor: string) => Promise<unknown>, parameters: Record<string, string> = {}) =>
    execute({ ...state.body, ...parameters }, "admin@example.test"),
  strings: (value: unknown) => Array.isArray(value) ? value : [],
  text: (body: Record<string, unknown>, key: string) => body[key],
}));
vi.mock("@/modules/channels/public", () => ({
  createDomain: state.createDomain,
}));

import { POST } from "@/app/api/admin/domains/route";

const postRequest = new Request("https://envoy.test/api/admin/domains", { method: "POST" });

describe("domain routes", () => {
  beforeEach(() => {
    state.body = {};
    state.createDomain.mockReset().mockResolvedValue({ domainId: "sd_test" });
  });

  it("registers a domain without a separate inbound provider selection", async () => {
    state.body = { domain: "example.test", accountIds: ["pa_test"] };
    await POST(postRequest);
    expect(state.createDomain).toHaveBeenCalledWith({
      domain: "example.test", accountIds: ["pa_test"],
    }, "admin@example.test");
  });
});
