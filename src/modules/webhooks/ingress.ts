import { createHash } from "node:crypto";
import type { ProviderType, WebhookRequest } from "@/modules/providers/contracts";
import { loadWebhookEndpoint } from "@/modules/config/webhook-endpoint";
import { objectStore } from "@/modules/config/object-store";
import { createId } from "@/server/ids";
import { completeObjectUploads, registerObjectUpload } from "@/server/services/object-cleanup";
import { transaction } from "@/server/database";
import { serializeVerification } from "@/modules/core/event/service";
import { PROVIDER_EVENT_RECEIVED } from "@/server/outbox-events";

export async function ingestProviderWebhook(provider: ProviderType, opaqueToken: string, request: WebhookRequest) {
  const endpoint = await loadWebhookEndpoint(provider, opaqueToken);
  if (!endpoint) return { status: 404 as const, error: "Webhook endpoint not found" };
  let verified;
  try {
    verified = await endpoint.module.webhook.verify(request, endpoint.context, endpoint.security)
  } catch {
    return { status: 401 as const, error: "Webhook verification failed" }
  }
  if (!verified.valid || !verified.replaySafe) return { status: 401 as const, error: "Webhook verification failed" };
  const eventId = verified.providerEventId ?? createHash("sha256").update(request.rawBody).digest("hex");
  const id = createId("raw");
  const storedHeaders = { ...request.headers };
  for (const name of ["authorization", "cookie", "x-api-key", "proxy-authorization"]) if (storedHeaders[name]) storedHeaders[name] = "[redacted]";
  if (request.remoteAddress) storedHeaders["x-envoy-source-ip"] = request.remoteAddress;
  const uploadKeys: string[] = [];
  try {
    let rawBody: Buffer | null = Buffer.from(request.rawBody);
    let objectKey: string | null = null;
    if (rawBody.byteLength > 64 * 1024) {
      objectKey = `provider-events/${provider}/${id}.bin`;
      uploadKeys.push(objectKey);
      await registerObjectUpload(objectKey);
      await objectStore().put(objectKey, rawBody, "application/octet-stream");
      rawBody = null
    }
    let verification: unknown = serializeVerification(verified);
    const receipt = Buffer.from(JSON.stringify(verification));
    if (receipt.byteLength > 64 * 1024) {
      const receiptKey = `provider-events/${provider}/${id}.receipt.json`;
      uploadKeys.push(receiptKey);
      await registerObjectUpload(receiptKey);
      await objectStore().put(receiptKey, receipt, "application/json");
      verification = { objectKey: receiptKey };
    }
    const inserted = await transaction(async client => {
      const result = await client.query(`INSERT INTO raw_provider_events(id,provider_account_id,webhook_endpoint_id,provider_event_id,native_type,signature_valid,replay_valid,raw_body,raw_object_key,headers,verification,security_version)
      VALUES ($1,$2,$3,$4,$5,true,true,$6,$7,$8,$9,$10) ON CONFLICT(provider_account_id,provider_event_id) DO NOTHING RETURNING id`, [id, endpoint.provider_account_id, endpoint.id, eventId, verified.nativeType, rawBody, objectKey, storedHeaders, verification, endpoint.security_version]);
      if (!result.rowCount) {
        const existing = await client.query<{ id: string }>("SELECT id FROM raw_provider_events WHERE provider_account_id=$1 AND provider_event_id=$2", [endpoint.provider_account_id, eventId]);
        return { duplicate: true, id: existing.rows[0].id };
      }
      await completeObjectUploads(client, uploadKeys);
      await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'raw_provider_event',$2,$3,$4)", [createId("out"), id, PROVIDER_EVENT_RECEIVED, { rawEventId: id }]);
      return { duplicate: false, id };
    });
    return { status: 202 as const, ...inserted };
  } catch (error) {
    await Promise.allSettled(uploadKeys.map(key => registerObjectUpload(key)));
    throw error;
  }
}
