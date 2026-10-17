import { databaseHealth } from "@/server/database";
import { queueSchemaHealth } from "@/server/queues";
import { outboxBacklog } from "@/server/services/outbox";

export const runtime = "nodejs";

export async function GET() {
  try {
    await Promise.all([
      databaseHealth(),
      queueSchemaHealth(),
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
