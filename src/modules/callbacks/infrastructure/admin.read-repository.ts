import {query} from '@/platform/database';
import type {CallbackEndpointDto,CallbackDeliveryDto} from '@/modules/admin/contracts';
export const callbackAdminReads={callbacks: () => query<CallbackEndpointDto>(`SELECT e.id,e.name,e.url,e.status,e.subscribed_events,s.id AS service_id,s.name AS service,
    count(d.id) FILTER(WHERE d.status='dead_letter') AS dead_letters,
    count(d.id) FILTER(WHERE d.status='delivering') AS in_flight
    FROM callback_endpoints e
    JOIN services s ON s.id=e.service_id
    LEFT JOIN callback_deliveries d ON d.endpoint_id=e.id
    WHERE e.url IS NOT NULL
    GROUP BY e.id,s.id,s.name ORDER BY e.created_at DESC`),
callbackDeliveries: () => query<CallbackDeliveryDto>(`SELECT d.id,d.endpoint_id,e.name AS endpoint,d.event_type,d.payload->>'id' AS event_id,d.payload_purged_at,d.status,d.attempt_count,d.next_attempt_at,d.response_code,d.last_error,d.delivered_at,d.created_at
    FROM callback_deliveries d JOIN callback_endpoints e ON e.id=d.endpoint_id ORDER BY d.created_at DESC LIMIT 200`)};

type CallbackDeliveryDetailDto=import('@/modules/admin/contracts').CallbackDeliveryDto & {url:string|null;payload:object;updated_at:Date};
export async function readAdminCallbackDelivery(id:string){
  const row=(await query<CallbackDeliveryDetailDto>(`SELECT d.id,d.endpoint_id,e.name AS endpoint,e.url,d.event_type,d.payload->>'id' AS event_id,d.payload,d.status,d.attempt_count,d.next_attempt_at,d.response_code,d.last_error,d.delivered_at,d.created_at,d.updated_at,d.payload_purged_at
    FROM callback_deliveries d JOIN callback_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1`,[id])).rows[0];
  return row??null;
}
