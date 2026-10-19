import type { PoolClient } from "pg";
import { database } from "@/platform/database";
import { auditLogs } from "@/platform/database/schema";
import { PROVIDER_EVENT_RECEIVED } from "@/platform/outbox/events";
import type { InboundManagementRepository } from "../application/management";
import { inboundRepository } from "./message.repository";

export function inboundManagementRepository(client: PoolClient): InboundManagementRepository {
  const orm = database(client);
  return {
    async resetRaw(id) { return !!(await client.query("UPDATE raw_provider_events SET processed_at=NULL,processing_error=NULL,processing_attempt_count=0,next_attempt_at=now() WHERE id=$1 AND content_purged_at IS NULL AND terminated_at IS NULL RETURNING id", [id])).rowCount; },
    async recoverUnroutedReceipt(id) {
      const rejected = (await client.query<{
        id: string; provider_account_id: string; webhook_endpoint_id: string;
        external_message_id: string; envelope_recipients: string[];
      }>(`SELECT m.id,r.provider_account_id,r.webhook_endpoint_id,m.external_message_id,m.envelope_recipients
        FROM raw_provider_events r
        JOIN inbound_messages m ON m.raw_provider_event_id=r.id AND m.provider_account_id=r.provider_account_id
        JOIN inbound_receipts receipt ON receipt.provider_account_id=r.provider_account_id
          AND receipt.external_message_id=m.external_message_id
        WHERE r.id=$1 AND m.service_id IS NULL AND m.delivery_scope='quarantine'
          AND m.status='rejected' AND m.rejection_reason='NO_RECEIVING_SERVICE'
          AND receipt.routes='[]'::jsonb AND receipt.terminated_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM inbound_messages copy
            WHERE copy.provider_account_id=r.provider_account_id
              AND copy.external_message_id=m.external_message_id AND copy.service_id IS NOT NULL)
        FOR UPDATE OF m,receipt`, [id])).rows[0];
      if (!rejected) return false;
      const routes = (await inboundRepository(client).findDispatches({
        endpointId: rejected.webhook_endpoint_id,
        recipients: rejected.envelope_recipients,
        accountId: rejected.provider_account_id,
      })).rows;
      if (!routes.length) return false;
      await client.query("UPDATE inbound_receipts SET routes=$3::jsonb WHERE provider_account_id=$1 AND external_message_id=$2", [
        rejected.provider_account_id, rejected.external_message_id, JSON.stringify(routes),
      ]);
      await client.query("DELETE FROM inbound_messages WHERE id=$1", [rejected.id]);
      return true;
    },
    async enqueueRaw(id, outboxId) { await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'raw_provider_event',$2,$3,$4)", [outboxId, id, PROVIDER_EVENT_RECEIVED, { rawEventId: id }]); },
    async lockCopies(id) { await client.query("SELECT id FROM inbound_messages WHERE raw_provider_event_id=$1 ORDER BY id FOR UPDATE", [id]); },
    async exhaustedRaw(id) {
      const row = (await client.query<{ provider_account_id: string }>(`SELECT provider_account_id FROM raw_provider_events WHERE id=$1 AND terminated_at IS NULL
        AND processed_at IS NULL AND processing_attempt_count>=20 AND processing_error IS NOT NULL AND next_attempt_at<=now() FOR UPDATE`, [id])).rows[0];
      return row ? { providerAccountId: row.provider_account_id } : null;
    },
    async activeCopy(id) { return !!(await client.query("SELECT id FROM inbound_messages WHERE raw_provider_event_id=$1 AND status='scanning' AND processing_token IS NOT NULL AND processing_deadline_at>now()", [id])).rowCount; },
    async terminateReceipt(id, accountId) { await client.query("UPDATE inbound_receipts SET terminated_at=clock_timestamp() WHERE provider_account_id=$2 AND external_message_id IN (SELECT external_message_id FROM inbound_messages WHERE raw_provider_event_id=$1)", [id, accountId]); },
    async rejectPendingCopies(id) { await client.query("UPDATE inbound_messages SET status='rejected',rejection_reason='INBOUND_PROCESSING_TERMINATED',processing_token=NULL,processing_deadline_at=NULL WHERE raw_provider_event_id=$1 AND status='scanning'", [id]); },
    async terminateRaw(id) { await client.query("UPDATE raw_provider_events SET terminated_at=clock_timestamp() WHERE id=$1", [id]); },
    async audit(actor, action, type, id, details = {}) { await orm.insert(auditLogs).values({ actor, action, resourceType: type, resourceId: id, details }); },
  };
}
