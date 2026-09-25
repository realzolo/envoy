import { databaseHealth } from "@/server/database";
import { redisHealth } from "@/server/redis";
import { outboxBacklog } from "@/server/services/outbox";

export const runtime = "nodejs";

export async function GET() {
  try {
    await Promise.all([
      databaseHealth(),
      redisHealth(),
      outboxBacklog(),
    ]);
    return Response.json({
      name: "envoy",
      status: "ok"
    });
  } catch {
    return Response.json({
      name: "envoy",
      status: "degraded"
    }, { status: 503 });
  }
}
