import { beforeEach,describe,expect,it,vi } from "vitest";

const state = vi.hoisted(() => ({ body: {} as Record<string,unknown>, replace: vi.fn() }));
vi.mock("@/server/admin-mutation", () => ({
  adminMutation: (_request: Request, execute: (body: Record<string,unknown>, actor: string) => Promise<unknown>, parameters: Record<string,string>) =>
    execute({ ...state.body, ...parameters }, "admin@example.test"),
}));
vi.mock("@/modules/callbacks/public", () => ({ replaceCallbackSecret: state.replace }));

import { PUT } from "@/app/api/admin/callback-endpoints/[id]/signing-secret/route";

const request = new Request("https://envoy.test/api/admin/callback-endpoints/cb_test/signing-secret", { method: "PUT" });
const context = { params: Promise.resolve({ id: "cb_test" }) };

describe("callback secret replacement route", () => {
  beforeEach(() => {
    state.body = {};
    state.replace.mockReset().mockResolvedValue({ secret: "generated-secret" });
  });

  it("generates a replacement without accepting a secret in the request", async () => {
    await expect(PUT(request,context)).resolves.toEqual({ result: { secret: "generated-secret" }, status: 200 });
    expect(state.replace).toHaveBeenCalledWith("cb_test", "admin@example.test");
    state.body = { secret: "manual-secret" };
    await expect(PUT(request,context)).rejects.toThrow("Callback secret cannot be supplied");
    expect(state.replace).toHaveBeenCalledTimes(1);
  });
});
