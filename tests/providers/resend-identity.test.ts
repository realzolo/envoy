import { describe, expect, it } from "vitest";
import { resendIdentityStatus } from "@/modules/providers/resend";

describe("Resend identity status mapping", () => {
  it("keeps incomplete Resend domain states ineligible for routing", () => {
    expect(resendIdentityStatus("verified")).toBe("verified");
    expect(resendIdentityStatus("failed")).toBe("failed");
    expect(resendIdentityStatus("not_started")).toBe("pending");
    expect(resendIdentityStatus("partially_verified")).toBe("pending");
    expect(resendIdentityStatus("partially_failed")).toBe("pending");
  });
});
