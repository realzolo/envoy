import { describe, expect, it, vi } from "vitest";

vi.mock("@/platform/database", () => ({ databaseHealth: vi.fn() }));
vi.mock("@/platform/queues", () => ({ queueSchemaHealth: vi.fn() }));
vi.mock("@/platform/outbox/public", () => ({ outboxBacklog: vi.fn() }));

import { GET } from "@/app/api/health/route";
import { databaseHealth } from "@/platform/database";
import { queueSchemaHealth } from "@/platform/queues";
import { outboxBacklog } from "@/platform/outbox/public";

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
