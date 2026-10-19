import { createId } from "@/platform/ids";
import type { PoolClient } from "pg";

export async function queuePermissionsChanged(client: PoolClient, serviceId: string) {
  const row = (await client.query<{ id: string; product_id: string }>(
    "SELECT e.id,s.product_id FROM callback_endpoints e JOIN services s ON s.id=e.service_id WHERE e.service_id=$1 AND e.status='active' AND 'service.permissions_changed'=ANY(e.subscribed_events)", [serviceId],
  )).rows[0];
  if (!row) return;
  const id = createId("cbx");
  const payload = { id: createId("evt"), apiVersion: "v1", type: "service.permissions_changed", occurredAt: new Date().toISOString(), data: { serviceId, productId: row.product_id } };
  await client.query("INSERT INTO callback_deliveries(id,endpoint_id,event_type,payload) VALUES($1,$2,'service.permissions_changed',$3)", [id, row.id, payload]);
  await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'callback',$2,'callback.requested',$3)", [createId("out"), id, { callbackDeliveryId: id }]);
}
