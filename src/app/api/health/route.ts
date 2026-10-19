import { checkSystemHealth } from "@/server/health";

export const runtime = "nodejs";

export async function GET() {
  try {
    await checkSystemHealth();
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
