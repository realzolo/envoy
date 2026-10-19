import { BodyTooLargeError, readRequestBytes } from "@/server/request-body";
import { providerTypeSchema } from "@/integrations/providers/contracts";
import { ingestProviderWebhook } from "@/modules/inbound/public";
import { clientIpFromTrustedProxy } from "@/platform/network";
import { recordRequest } from "@/server/request-log";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: {
  params: Promise<{ provider: string; endpointId: string }>
}) {
  const started = Date.now();
  const values = await params;
  const provider = providerTypeSchema.safeParse(values.provider);
  if (!provider.success) return Response.json({ title: "Not found", status: 404 }, { status: 404 });
  let rawBody: Uint8Array;
  try { rawBody = await readRequestBytes(request,32*1024*1024) }
  catch(error) { return Response.json({title:error instanceof BodyTooLargeError ? "Payload too large":"Invalid request body"},{status:error instanceof BodyTooLargeError ? 413:400}) }
  const headers = Object.fromEntries([...request.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
  const result = await ingestProviderWebhook(provider.data, values.endpointId, {
    rawBody,
    headers,
    remoteAddress: clientIpFromTrustedProxy(request)
  });
  await recordRequest({
    method: "POST",
    path: `/api/provider-events/${provider.data}/:endpoint`,
    statusCode: result.status,
    durationMs: Date.now() - started,
    actor: `provider:${provider.data}`,
    details: { duplicate: "duplicate" in result ? result.duplicate : false, ...(result.status !== 202 ? {reason:result.error}: {}) }
  });
  return Response.json(result.status === 202 ? { accepted: true, duplicate: result.duplicate } : {
    title: result.error,
    status: result.status
  }, { status: result.status })
}
