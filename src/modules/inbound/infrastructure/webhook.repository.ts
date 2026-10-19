import type { PoolClient } from "pg";
import { transactionContext } from "@/platform/database";
import { completeObjectUploads } from "@/platform/storage/object-cleanup/public";
import { PROVIDER_EVENT_RECEIVED } from "@/platform/outbox/events";
import type { WebhookRepository } from "../application/webhook-ports";

export function webhookRepository(client: PoolClient): WebhookRepository {
  return {
    async insertReceipt(r) {
      return !!(await client.query(`INSERT INTO raw_provider_events(id,provider_account_id,webhook_endpoint_id,provider_event_id,native_type,signature_valid,replay_valid,raw_body,raw_object_key,headers,verification,security_version,payload_expires_at,normalized_events)
        VALUES ($1,$2,$3,$4,$5,true,true,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(provider_account_id,provider_event_id) DO NOTHING RETURNING id`,
      [r.id, r.accountId, r.endpointId, r.providerEventId, r.nativeType, r.rawBody, r.objectKey, {}, r.verification, r.securityVersion, r.expiresAt, r.normalizedJson])).rowCount;
    },
    async existingId(accountId, eventId) { return (await client.query<{ id: string }>("SELECT id FROM raw_provider_events WHERE provider_account_id=$1 AND provider_event_id=$2", [accountId, eventId])).rows[0].id; },
    completeUploads: keys => completeObjectUploads(transactionContext(client), keys),
    async enqueue(id, outboxId) { await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'raw_provider_event',$2,$3,$4)", [outboxId, id, PROVIDER_EVENT_RECEIVED, { rawEventId: id }]); },
  };
}
