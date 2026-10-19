import { afterAll, expect, it } from "vitest";
import { db, query } from "@/platform/database";
import { decodeCursor, listMessages } from "@/modules/outbound/public";
import { listDeliveries, listEvents } from "@/modules/outbound/public";
import { listInboundMessages } from "@/modules/inbound/public";

const key = crypto.randomUUID().replaceAll("-", "");
const serviceId = `svc_pagination_${key}`;
afterAll(async () => {
  await query("DELETE FROM inbound_messages WHERE service_id=$1", [serviceId]);
  await query("DELETE FROM messages WHERE service_id=$1", [serviceId]);
  await query("DELETE FROM services WHERE id=$1", [serviceId]);
  await db().end();
});

it("pages every message, delivery, event and inbound row at one exact PostgreSQL microsecond", async () => {
  await query("INSERT INTO services(id,name) VALUES ($1,$1)", [serviceId]);
  await query("INSERT INTO service_domain_grants(id,service_id,sending_domain_id,send_allowed,receive_allowed) VALUES($1,$2,'sd_atlas',true,true)",[`grant_${key}`,serviceId]);
  await query(`INSERT INTO messages(id,service_id,sending_domain_id,idempotency_key,payload_hash,recipient_count,subject,text_body,message_category,sender_snapshot,accepted_at)
    SELECT 'msg_'||$1||'_'||lpad(i::text,3,'0'),$2,'sd_atlas',i::text,'fixture',1,'Pagination','body','security',$3,'2026-10-17T00:00:00.123456Z'::timestamptz FROM generate_series(1,225) i`, [key, serviceId, { service: "Atlas Auth", fromName: "Atlas", fromEmail: "security@mail.atlas.test", domainId: "sd_atlas" }]);
  await query(`INSERT INTO deliveries(id,message_id,recipient_email,recipient_role,queued_at) SELECT 'dlv_'||$1||'_'||lpad(i::text,3,'0'),'msg_'||$1||'_'||lpad(i::text,3,'0'),'pagination-'||i||'@example.net','to','2026-10-17T00:00:00.123456Z'::timestamptz FROM generate_series(1,225) i`, [key]);
  const deliveryId = `dlv_${key}_001`;
  await query(`INSERT INTO delivery_events(id,delivery_id,event_type,occurred_at,canonical_payload,source_key) SELECT 'dev_'||$1||'_'||lpad(i::text,3,'0'),$2,'opened','2026-10-17T00:00:00.123456Z'::timestamptz,'{}'::jsonb,$1||i FROM generate_series(1,225) i`, [key, deliveryId]);
  await query(`INSERT INTO inbound_messages(id,service_id,provider_account_id,from_email,to_emails,envelope_recipients,subject,status,received_at,created_at) SELECT 'inb_'||$1||'_'||lpad(i::text,3,'0'),$2,'pa_mock','sender@example.net',ARRAY['support@mail.atlas.test'],ARRAY['support@mail.atlas.test'],'Pagination','ready','2026-10-17T00:00:00.123456Z'::timestamptz,'2026-10-17T00:00:00.123456Z'::timestamptz FROM generate_series(1,225) i`, [key, serviceId]);
  const loaders = [
    (cursor: ReturnType<typeof decodeCursor>) => listMessages(serviceId, { limit: 20, cursor }),
    (cursor: ReturnType<typeof decodeCursor>) => listDeliveries(serviceId, { limit: 20, cursor }),
    (cursor: ReturnType<typeof decodeCursor>) => listEvents(serviceId, { limit: 20, cursor, deliveryId }),
    (cursor: ReturnType<typeof decodeCursor>) => listInboundMessages(serviceId, { limit: 20, cursor }),
  ];
  for (const load of loaders) {
    const ids: string[] = [];
    let cursor: ReturnType<typeof decodeCursor> = null;
    for (let page = 0; page < 20; page++) {
      const result = await load(cursor);
      ids.push(...result.data.map(item => item.id));
      if (!result.nextCursor) break;
      cursor = decodeCursor(result.nextCursor);
      expect(cursor?.at).toBe("2026-10-17T00:00:00.123456Z");
    }
    expect(ids).toHaveLength(225);
    expect(new Set(ids).size).toBe(225);
  }
});
