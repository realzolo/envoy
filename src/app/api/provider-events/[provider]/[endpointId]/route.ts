import { providerTypeSchema } from "@/modules/providers/contracts";
import { ingestProviderWebhook } from "@/modules/webhooks/ingress";
import { recordRequest } from "@/server/request-log";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: {
  params: Promise<{ provider: string; endpointId: string }>
}) {
  const started = Date.now();
  const values = await params;
  const provider = providerTypeSchema.safeParse(values.provider);
  if (!provider.success) return Response.json({ title: "Not found", status: 404 }, { status: 404 });
  const declaredSize = Number(request.headers.get("content-length") ?? 0);
  if (declaredSize > 32 * 1024 * 1024) return Response.json({
    title: "Payload too large",
    status: 413
  }, { status: 413 });
  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > 32 * 1024 * 1024) return Response.json({
    title: "Payload too large",
    status: 413
  }, { status: 413 });
  const headers = Object.fromEntries([...request.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
  const result = await ingestProviderWebhook(provider.data, values.endpointId, {
    rawBody,
    headers,
    remoteAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  });
  await recordRequest({
    method: "POST",
    path: `/api/provider-events/${provider.data}/:endpoint`,
    statusCode: result.status,
    durationMs: Date.now() - started,
    actor: `provider:${provider.data}`,
    details: { duplicate: "duplicate" in result ? result.duplicate : false }
  });
  return Response.json(result.status === 202 ? { accepted: true, duplicate: result.duplicate } : {
    title: result.error,
    status: result.status
  }, { status: result.status })
}
