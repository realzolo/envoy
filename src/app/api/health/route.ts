import { databaseHealth } from "@/server/database";
import { redisHealth } from "@/server/redis";
import { outboxBacklog } from "@/server/services/outbox";

export const runtime = "nodejs";

export async function GET() {
  try {
    const [databaseTime, redisStatus, pendingOutbox] = await Promise.all([
      databaseHealth(),
      redisHealth(),
      outboxBacklog(),
    ]);
    return Response.json({
      name: "envoy",
      status: "ok",
      version: process.env.npm_package_version ?? "0.1.0",
      time: new Date().toISOString(),
      dependencies: { database: databaseTime.toISOString(), redis: redisStatus, pendingOutbox },
    });
  } catch (error) {
    return Response.json({
      name: "envoy",
      status: "degraded",
      error: error instanceof Error ? error.message : "Unknown dependency error"
    }, { status: 503 });
  }
}
