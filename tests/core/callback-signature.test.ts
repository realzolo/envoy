import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyCallback } from "../../examples/service-mail.mjs";

const secret = "single-callback-fixture-secret";
const now = 1_800_000_000;
const body = Buffer.from('{"id":"event-1","subject":"你好 👋"}', "utf8");
function headers(timestamp = String(now), bytes = body) {
  return {
    "x-envoy-timestamp": timestamp,
    "x-envoy-signature": `v1=${createHmac("sha256", secret).update(`${timestamp}.`).update(bytes).digest("hex")}`,
  };
}
afterEach(() => vi.restoreAllMocks());

describe("single-secret callback verification contract", () => {
  it.each([-300, 0, 300])("accepts original UTF-8 bytes within the fixed 300-second window (%s)", skew => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    expect(verifyCallback(headers(String(now + skew)), body, secret)).toBe(true);
  });
  it.each([-301, 301])("rejects correctly signed but expired or future timestamps (%s)", skew => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    expect(verifyCallback(headers(String(now + skew)), body, secret)).toBe(false);
  });
  it("rejects a different secret, changed bytes and malformed signature headers", () => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    expect(verifyCallback(headers(), body, "different-callback-secret")).toBe(false);
    expect(verifyCallback(headers(), Buffer.from(`${body.toString("utf8")} `), secret)).toBe(false);
    expect(verifyCallback(headers("1800000000.0"), body, secret)).toBe(false);
    expect(verifyCallback({ ...headers(), "x-envoy-signature": "v1=invalid" }, body, secret)).toBe(false);
  });
});
