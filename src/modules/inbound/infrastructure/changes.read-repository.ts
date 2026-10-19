import type { PoolClient } from "pg";
import { inboundDomainAccess } from "@/modules/identity/infrastructure/authorization";
import type { InboundChangesRepository } from "../application/changes";

/** Writers lock the stream head until commit; readers take FOR SHARE to see a committed prefix. */
export function inboundChangesRepository(client: PoolClient): InboundChangesRepository {
  return {
    async ensureStream(serviceId) { await client.query("INSERT INTO inbound_streams(service_id) VALUES($1) ON CONFLICT DO NOTHING", [serviceId]); },
    async lockHead(serviceId) { return (await client.query<{ generation: string; position: string; floor: string }>("SELECT generation,position::text,floor::text FROM inbound_streams WHERE service_id=$1 FOR SHARE", [serviceId])).rows[0]; },
    async readPrefix(serviceId, after, head, limit) {
      const rows = (await client.query<{ id: string; position: string; inbound_message_id: string; type: string; recorded_at: Date }>(
        `SELECT c.id,c.position::text,c.inbound_message_id,c.type,c.recorded_at FROM inbound_changes c JOIN inbound_messages i ON i.id=c.inbound_message_id
         WHERE c.service_id=$1 AND c.position>$2 AND c.position<=$3 AND ${inboundDomainAccess('i')} ORDER BY c.position LIMIT $4`, [serviceId, after, head, limit])).rows;
      return rows.map(row => ({ id: row.id, position: row.position, inboundMessageId: row.inbound_message_id, type: row.type, recordedAt: row.recorded_at }));
    },
  };
}
