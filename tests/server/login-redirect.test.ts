import { describe, expect, it } from "vitest";
import { localRedirect } from "@/components/login-form";

describe("admin login redirect", () => {
  const origin = "https://envoy.example";

  it("keeps an approved local destination", () => {
    expect(localRedirect("/providers?tab=resend#setup", origin)).toBe("/providers?tab=resend#setup");
  });

  it("rejects scheme-relative, backslash-normalized, and absolute external destinations", () => {
    expect(localRedirect("//attacker.example", origin)).toBe("/");
    expect(localRedirect("/\\attacker.example", origin)).toBe("/");
    expect(localRedirect("https://attacker.example", origin)).toBe("/");
  });
});
