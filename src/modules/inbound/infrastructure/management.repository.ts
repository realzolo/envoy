import type { PoolClient } from "pg";
import { eq } from "drizzle-orm";
import { database } from "@/platform/database";
import { auditLogs, inboundRoutes } from "@/platform/database/schema";
import { domainPermission } from "@/modules/identity/infrastructure/authorization";
import { PROVIDER_EVENT_RECEIVED } from "@/platform/outbox/events";
import type { ProviderType } from "@/integrations/providers/contracts";
import type { InboundManagementRepository } from "../application/management";

export function inboundManagementRepository(client: PoolClient): InboundManagementRepository {
  const orm = database(client);
  return {
    async resetRaw(id) { return !!(await client.query("UPDATE raw_provider_events SET processed_at=NULL,processing_error=NULL,processing_attempt_count=0,next_attempt_at=now() WHERE id=$1 AND content_purged_at IS NULL AND terminated_at IS NULL RETURNING id", [id])).rowCount; },
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
    async routeEndpoint(id) {
      const row = (await client.query<{ type: ProviderType; status: string; security_configured: boolean }>("SELECT a.type,e.status,e.security_configured FROM provider_webhook_endpoints e JOIN provider_accounts a ON a.id=e.provider_account_id WHERE e.id=$1", [id])).rows[0];
      return row ? { type: row.type, status: row.status, securityConfigured: row.security_configured } : null;
    },
    async receivingPermission(input) { return !!(await client.query(`SELECT s.id FROM services s WHERE s.id=$1 AND s.product_id=$2 AND ${domainPermission("s.id", "$3", "receive")}`, [input.serviceId, input.productId, input.domainId])).rowCount; },
    async insertRoute(id, input) {
      try {
        await orm.insert(inboundRoutes).values({ id, providerWebhookEndpointId: input.webhookEndpointId, sendingDomainId: input.domainId, productId: input.productId, serviceId: input.serviceId });
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        if (cause && typeof cause === "object" && "code" in cause && cause.code === "23505") throw new Error("A duplicate inbound route already exists", { cause: error });
        throw error;
      }
    },
    async toggleRoute(id, enabled) { await orm.update(inboundRoutes).set({ status: enabled ? "active" : "disabled" }).where(eq(inboundRoutes.id, id)); },
    async audit(actor, action, type, id, details = {}) { await orm.insert(auditLogs).values({ actor, action, resourceType: type, resourceId: id, details }); },
  };
}
