import type { PoolClient } from "pg";
import { outboundDomainAccess } from "@/modules/identity/infrastructure/authorization";
import type { OutboundChangesRepository } from "../application/changes";

/** Stream row locks expose a complete committed prefix despite overlapping writers. */
export function outboundChangesRepository(client: PoolClient): OutboundChangesRepository {
  return {
    async ensureStream(serviceId) { await client.query("INSERT INTO outbound_streams(service_id) VALUES($1) ON CONFLICT DO NOTHING", [serviceId]); },
    async lockHead(serviceId) { return (await client.query<{ generation: string; position: string; floor: string }>("SELECT generation,position::text,floor::text FROM outbound_streams WHERE service_id=$1 FOR SHARE", [serviceId])).rows[0]; },
    async readPrefix(serviceId, after, head, limit) {
      const rows = (await client.query<{ id: string; position: string; message_id: string; type: string; recorded_at: Date }>(
        `SELECT c.id,c.position::text,c.message_id,c.type,c.recorded_at FROM outbound_changes c JOIN messages m ON m.id=c.message_id
         WHERE c.service_id=$1 AND c.position>$2 AND c.position<=$3 AND ${outboundDomainAccess('m')} ORDER BY c.position LIMIT $4`, [serviceId, after, head, limit])).rows;
      return rows.map(row => ({ id: row.id, position: row.position, messageId: row.message_id, type: row.type, recordedAt: row.recorded_at }));
    },
  };
}
