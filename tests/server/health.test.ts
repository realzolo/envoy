import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/database", () => ({ databaseHealth: vi.fn() }));
vi.mock("@/server/queues", () => ({ queueSchemaHealth: vi.fn() }));
vi.mock("@/server/services/outbox", () => ({ outboxBacklog: vi.fn() }));

import { GET } from "@/app/api/health/route";
import { databaseHealth } from "@/server/database";
import { queueSchemaHealth } from "@/server/queues";
import { outboxBacklog } from "@/server/services/outbox";

describe("public health endpoint", () => {
  it("returns only the stable public success shape", async () => {
    vi.mocked(databaseHealth).mockResolvedValueOnce(new Date());
    vi.mocked(queueSchemaHealth).mockResolvedValueOnce(undefined);
    vi.mocked(outboxBacklog).mockResolvedValueOnce(0);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "envoy", status: "ok" });
  });

  it("does not expose dependency errors", async () => {
    vi.mocked(databaseHealth).mockRejectedValueOnce(new Error("postgres://user:password@database.internal:5432/envoy"));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ name: "envoy", status: "degraded" });
  });
});
