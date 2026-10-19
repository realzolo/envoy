import { describe,expect,it } from "vitest";
import { callbackInputSchema } from "@/modules/callbacks/contracts";

describe("callback input", () => {
  const input = {
    serviceId: "svc_test", name: "Events", url: "https://example.test/events",
    events: ["email.delivered"],
  };

  it("rejects a client-supplied signing secret", () => {
    expect(callbackInputSchema.safeParse(input).success).toBe(true);
    expect(callbackInputSchema.safeParse({ ...input, secret: "manually-chosen-secret" }).success).toBe(false);
  });
});
