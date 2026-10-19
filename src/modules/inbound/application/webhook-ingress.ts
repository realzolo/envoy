import { contentFreeOutboundEvents } from "@/integrations/providers/event-facts";
import type { CanonicalEvent, ProviderType, WebhookRequest } from "@/integrations/providers/contracts";
import type { WebhookDependencies } from "./webhook-ports";

export function createWebhookIngress(dependencies: WebhookDependencies) {
async function ingestProviderWebhook(provider: ProviderType, opaqueToken: string, request: WebhookRequest) {
  const endpoint = await dependencies.loadEndpoint(provider, opaqueToken);
  if (!endpoint) return { status: 404 as const, error: "Webhook endpoint not found" };
  let verified;
  try {
    verified = await endpoint.module.webhook.verify(request, endpoint.context, endpoint.security)
  } catch {
    return { status: 401 as const, error: "Webhook verification failed" }
  }
  if (!verified.valid || !verified.replaySafe) return { status: 401 as const, error: "Webhook verification failed" };
  // Normalization is provider-local parsing, never mailbox fetching. Freeze only content-free outbound facts.
  let normalized: CanonicalEvent[] | null = null;
  try {
    normalized = contentFreeOutboundEvents(await endpoint.module.webhook.normalize(verified, endpoint.context));
  } catch { /* Persist the encrypted verified receipt; the worker owns parsing failures/retry. */ }
  const eventId = verified.providerEventId ?? dependencies.digest(request.rawBody);
  const id = dependencies.id("raw");
  const storedHeaders = { ...request.headers };
  for (const name of ["authorization", "cookie", "x-api-key", "proxy-authorization"]) if (storedHeaders[name]) storedHeaders[name] = "[redacted]";
  if (request.remoteAddress) storedHeaders["x-envoy-source-ip"] = request.remoteAddress;
  const uploadKeys: string[] = [];
  try {
    let rawBody: Buffer | null = Buffer.from(JSON.stringify(dependencies.seal({ body: Buffer.from(request.rawBody).toString("base64"), headers: storedHeaders }, `provider-raw:${id}`, 1)));
    let objectKey: string | null = null;
    if (rawBody.byteLength > 64 * 1024) {
      objectKey = `provider-events/${provider}/${id}.bin`;
      uploadKeys.push(objectKey);
      await dependencies.uploads.register(objectKey);
      await dependencies.uploads.put(objectKey, rawBody, "application/octet-stream");
      rawBody = null
    }
    let verification: unknown = dependencies.seal(dependencies.encodeVerification(verified), `provider-receipt:${id}`, 1);
    const receipt = Buffer.from(JSON.stringify(verification));
    if (receipt.byteLength > 64 * 1024) {
      const receiptKey = `provider-events/${provider}/${id}.receipt.json`;
      uploadKeys.push(receiptKey);
      await dependencies.uploads.register(receiptKey);
      await dependencies.uploads.put(receiptKey, receipt, "application/json");
      verification = { objectKey: receiptKey };
    }
    const inserted = await dependencies.unitOfWork.run(async repository => {
      const created = await repository.insertReceipt({ id, accountId: endpoint.provider_account_id, endpointId: endpoint.id,
        providerEventId: eventId, nativeType: verified.nativeType, rawBody, objectKey, verification, securityVersion: endpoint.security_version,
        expiresAt: normalized ? new Date(Date.now() + 900_000) : null, normalizedJson: normalized ? JSON.stringify(normalized) : null });
      if (!created) return { duplicate: true, id: await repository.existingId(endpoint.provider_account_id, eventId) };
      await repository.completeUploads(uploadKeys);
      await repository.enqueue(id, dependencies.id("out"));
      return { duplicate: false, id };
    });
    return { status: 202 as const, ...inserted };
  } catch (error) {
    await Promise.allSettled(uploadKeys.map(key => dependencies.uploads.register(key)));
    throw error;
  }
}

return { ingestProviderWebhook };
}
