import { describe, expect, it, vi } from "vitest";
import { writeWorkerHeartbeat } from "@/server/redis";

describe("worker heartbeat", () => {
  it("writes an expiring worker marker", async () => {
    const connection = { set: vi.fn().mockResolvedValue("OK") };

    await writeWorkerHeartbeat(connection as never, "worker-a");

    expect(connection.set).toHaveBeenCalledWith(
      "envoy:worker:heartbeat",
      expect.stringMatching(/"workerId":"worker-a"/),
      "EX",
      45,
    );
  });
});
