import { describe, expect, it } from "vitest";
import { evaluateCandidate } from "@/modules/outbound/domain/routing";

const candidate = {
  account_status: "active",
  health: { status: "healthy" },
  identity_status: "verified",
  domain_status: "active",
};

describe("bound outbound identity eligibility", () => {
  it("accepts an active verified identity within quota", () => {
    expect(evaluateCandidate(candidate)).toEqual([]);
  });

  it("reports unavailable account, identity, and domain", () => {
    expect(evaluateCandidate({ ...candidate, account_status: "disabled", identity_status: "pending", domain_status: "disabled" })).toEqual([
      "account_unavailable", "identity_unverified", "domain_disabled",
    ]);
  });
});
