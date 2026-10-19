import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  body: {} as Record<string, unknown>,
  setInbound: vi.fn(),
  createDomain: vi.fn(),
}));
vi.mock("@/server/admin-mutation", () => ({
  adminMutation: (_request: Request, execute: (body: Record<string, unknown>, actor: string) => Promise<unknown>, parameters: Record<string, string> = {}) =>
    execute({ ...state.body, ...parameters }, "admin@example.test"),
  strings: (value: unknown) => Array.isArray(value) ? value : [],
  text: (body: Record<string, unknown>, key: string) => body[key],
}));
vi.mock("@/modules/channels/public", () => ({
  setDomainInboundProvider: state.setInbound,
  createDomain: state.createDomain,
}));

import { PUT } from "@/app/api/admin/domains/[id]/route";
import { POST } from "@/app/api/admin/domains/route";

const putRequest = new Request("https://envoy.test/api/admin/domains/sd_test", { method: "PUT" });
const postRequest = new Request("https://envoy.test/api/admin/domains", { method: "POST" });
const context = { params: Promise.resolve({ id: "sd_test" }) };

describe("domain routes", () => {
  beforeEach(() => {
    state.body = {};
    state.setInbound.mockReset().mockResolvedValue(undefined);
    state.createDomain.mockReset().mockResolvedValue({ domainId: "sd_test" });
  });

  it("requires an explicit inbound provider ID or null when updating a domain", async () => {
    await expect(PUT(putRequest, context)).rejects.toThrow();
    state.body = { inboundProviderAccountId: 42 };
    await expect(PUT(putRequest, context)).rejects.toThrow();
    expect(state.setInbound).not.toHaveBeenCalled();

    state.body = { inboundProviderAccountId: null };
    await PUT(putRequest, context);
    expect(state.setInbound).toHaveBeenCalledWith("sd_test", null, "admin@example.test");
  });

  it("preserves an omitted inbound provider field when adding a provider", async () => {
    state.body = { domain: "example.test", accountIds: ["pa_test"] };
    await POST(postRequest);
    expect(state.createDomain).toHaveBeenCalledWith({
      domain: "example.test", accountIds: ["pa_test"], inboundProviderAccountId: undefined,
    }, "admin@example.test");
  });
});
