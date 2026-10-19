import { createId } from "@/platform/ids";
import { transactionClient } from "@/platform/database";
import type { TransactionContext } from "@/platform/transactions";
import type { PoolClient } from "pg";

export async function queuePermissionsChanged(client: PoolClient, serviceId: string) {
  const row = (await client.query<{ id: string }>(
    "SELECT e.id FROM callback_endpoints e WHERE e.service_id=$1 AND e.status='active' AND 'service.permissions_changed'=ANY(e.subscribed_events)", [serviceId],
  )).rows[0];
  if (!row) return;
  const id = createId("cbx");
  const payload = { id: createId("evt"), apiVersion: "v1", type: "service.permissions_changed", occurredAt: new Date().toISOString(), data: { serviceId } };
  await client.query("INSERT INTO callback_deliveries(id,endpoint_id,event_type,payload) VALUES($1,$2,'service.permissions_changed',$3)", [id, row.id, payload]);
  await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'callback',$2,'callback.requested',$3)", [createId("out"), id, { callbackDeliveryId: id }]);
}

export async function notifyDomainBindingsChanged(domainId: string, receiveOnly: boolean, context: TransactionContext) {
  const client = transactionClient(context);
  const affected = await client.query<{ id: string }>(`UPDATE services s
    SET configuration_revision=configuration_revision+1,updated_at=now()
    WHERE EXISTS(SELECT 1 FROM service_domain_bindings b
      WHERE b.service_id=s.id AND b.sending_domain_id=$1 AND (NOT $2::boolean OR b.receive_enabled))
    RETURNING s.id`, [domainId, receiveOnly]);
  for (const row of affected.rows) await queuePermissionsChanged(client, row.id);
}
