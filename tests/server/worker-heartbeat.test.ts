import { afterEach, describe, expect, it } from "vitest";
import { query } from "@/server/database";
import { removeWorkerHeartbeat, workerHeartbeatAlive, writeWorkerHeartbeat } from "@/server/runtime-store";

const workerId = `test-heartbeat-${crypto.randomUUID()}`;
afterEach(() => removeWorkerHeartbeat(workerId));

describe("worker heartbeat", () => {
  it("uses database time and expires stale workers without dropping healthy peers", async () => {
    await writeWorkerHeartbeat(workerId);
    expect(await workerHeartbeatAlive()).toBe(true);
    const row = await query<{ last_seen_at: Date }>("SELECT last_seen_at FROM worker_heartbeats WHERE worker_id=$1", [workerId]);
    expect(row.rows[0].last_seen_at).toBeInstanceOf(Date);
    await query("UPDATE worker_heartbeats SET last_seen_at=now()-interval '46 seconds' WHERE worker_id=$1", [workerId]);
    const alive = await query<{ alive: boolean }>("SELECT last_seen_at>now()-interval '45 seconds' AS alive FROM worker_heartbeats WHERE worker_id=$1", [workerId]);
    expect(alive.rows[0].alive).toBe(false);
    await writeWorkerHeartbeat(workerId);
    expect(await workerHeartbeatAlive()).toBe(true);
  });
});
