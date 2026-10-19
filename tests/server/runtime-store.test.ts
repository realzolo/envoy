import { afterEach, describe, expect, it } from "vitest";
import { query, transaction } from "@/platform/database";
import { cleanupRuntimeStore, enforceScopedRateLimit, reserveRateLimits } from "@/platform/runtime-store";

const scope = `runtime-test-${crypto.randomUUID()}`;
afterEach(async () => { await query("DELETE FROM rate_limit_counters WHERE scope=$1", [scope]); });

describe("PostgreSQL runtime store", () => {
  it("atomically permits exactly the fixed-window budget across concurrent callers", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => enforceScopedRateLimit(scope, "concurrent", 7, 3600)));
    expect(results.filter(Boolean)).toHaveLength(7);
  });

  it("rolls back all reservations when any provider/identity budget is exhausted", async () => {
    expect(await enforceScopedRateLimit(scope, "identity", 1, 3600)).toBe(true);
    const allowed = await transaction(client => reserveRateLimits(client, [
      { scope, key: "provider", limit: 5, windowSeconds: 3600 },
      { scope, key: "identity", limit: 1, windowSeconds: 3600 },
    ]));
    expect(allowed).toBe(false);
    const result = await query<{ count: string }>("SELECT count FROM rate_limit_counters WHERE scope=$1 AND key='provider'", [scope]);
    expect(result.rowCount).toBe(0);
  });

  it("rolls rate reservations back with the surrounding business transaction", async () => {
    await expect(transaction(async client => {
      expect(await reserveRateLimits(client, [{ scope, key: "rollback", limit: 1, windowSeconds: 3600 }])).toBe(true);
      throw new Error("business rollback");
    })).rejects.toThrow("business rollback");
    expect(await enforceScopedRateLimit(scope, "rollback", 1, 3600)).toBe(true);
  });

  it("cleans expired counters while preserving the current window", async () => {
    await enforceScopedRateLimit(scope, "live", 1, 3600);
    await query("INSERT INTO rate_limit_counters(scope,key,window_start,count,expires_at) VALUES ($1,'old',now()-interval '2 days',1,now()-interval '1 day')", [scope]);
    await cleanupRuntimeStore();
    const rows = await query<{ key: string }>("SELECT key FROM rate_limit_counters WHERE scope=$1", [scope]);
    expect(rows.rows.map(row => row.key)).toEqual(["live"]);
  });
});
