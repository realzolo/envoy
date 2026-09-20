import { createHmac, timingSafeEqual } from "node:crypto";
import { query } from "@/server/database";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const timestamp = request.headers.get("x-envoy-timestamp") ?? "";
  const supplied = request.headers.get("x-envoy-signature")?.replace(/^v1=/, "") ?? "";
  const body = await request.text();
  const expected = createHmac("sha256", "envoy_local_callback_secret").update(`${timestamp}.${body}`).digest("hex");
  const valid = supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) return Response.json({ error: "Invalid signature" }, { status: 401 });
  const payload = JSON.parse(body) as { id?: string; type?: string };
  await query(
    `INSERT INTO audit_logs(actor, action, resource_type, resource_id, details)
     VALUES ('callback-sink', 'callback.received', 'callback_event', $1, $2)`,
    [payload.id ?? null, payload],
  );
  return Response.json({ received: true });
}
