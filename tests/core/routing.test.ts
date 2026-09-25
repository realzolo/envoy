import { describe, expect, it } from "vitest";
import { choosePolicyTarget, chooseWeighted } from "@/modules/core/routing/engine";

const candidate = (id: string, overrides: Partial<{
  priority: number;
  weight: number
}> = {}) => ({
  id,
  priority: 100,
  weight: 100,
  ...overrides
});
describe("routing selection", () => {
  it("always selects the lowest priority tier", () => {
    expect(chooseWeighted("delivery", 1, [candidate("secondary", { priority: 200 }), candidate("primary", { priority: 10 })])?.id).toBe("primary")
  });
  it("uses deterministic weighted selection", () => {
    const list = [candidate("a", { weight: 1 }), candidate("b", { weight: 9 })];
    expect(chooseWeighted("same", 1, list)?.id).toBe(chooseWeighted("same", 1, list)?.id)
  });
});
describe("policy precedence", () => {
  it("evaluates policy priority before target priority", () => {
    const target = choosePolicyTarget("delivery", 1, [{
      id: "high-policy-low-target",
      policyPriority: 200,
      priority: 1,
      weight: 100
    }, { id: "low-policy-high-target", policyPriority: 10, priority: 500, weight: 100 }]);
    expect(target?.id).toBe("low-policy-high-target")
  })
});
