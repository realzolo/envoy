import { transaction } from "@/server/database";

export class InboundCursorError extends Error {
  constructor(public code: "INVALID_INBOUND_CURSOR" | "INBOUND_CURSOR_EXPIRED", public resetCursor?: string) { super(code); }
}
const encode = (service: string, generation: string, position: string) => Buffer.from(JSON.stringify({ service, generation, position })).toString("base64url");

/** READ COMMITTED + head FOR SHARE: all pages see an atomic committed prefix.
 * Writers hold the head row lock until commit. There can be no late commit below a returned cursor.
 * Page-local watermark bounds concurrent appends; a tail cursor remains reusable even on an empty page.
 */
export async function listInboundChanges(serviceId: string, limit: number, cursor?: string | null) {
  return transaction(async client => {
    await client.query("INSERT INTO inbound_streams(service_id) VALUES($1) ON CONFLICT DO NOTHING", [serviceId]);
    const head = (await client.query<{ generation: string; position: string; floor: string }>("SELECT generation,position::text,floor::text FROM inbound_streams WHERE service_id=$1 FOR SHARE", [serviceId])).rows[0];
    let after = head.floor;
    const reset = encode(serviceId,head.generation,head.floor);
    if (cursor) {
      let parsed;
      try { parsed = JSON.parse(Buffer.from(cursor,"base64url").toString()); } catch { throw new InboundCursorError("INVALID_INBOUND_CURSOR"); }
      if (!parsed || typeof parsed !== "object" || parsed.service !== serviceId || typeof parsed.position !== "string" || !/^\d{1,19}$/.test(parsed.position)) throw new InboundCursorError("INVALID_INBOUND_CURSOR");
      if (parsed.generation !== head.generation || BigInt(parsed.position) < BigInt(head.floor)) throw new InboundCursorError("INBOUND_CURSOR_EXPIRED",reset);
      if (BigInt(parsed.position) > BigInt(head.position)) throw new InboundCursorError("INVALID_INBOUND_CURSOR");
      after = parsed.position;
    }
    const rows = (await client.query<{ id: string; position: string; inbound_message_id: string; type: string; recorded_at: Date }>(
      "SELECT id,position::text,inbound_message_id,type,recorded_at FROM inbound_changes WHERE service_id=$1 AND position>$2 AND position<=$3 ORDER BY inbound_changes.position LIMIT $4",[serviceId,after,head.position,limit+1])).rows;
    const hasMore = rows.length > limit;
    const data = rows.slice(0,limit);
    const end = data.at(-1)?.position ?? after;
    return { data: data.map(row => ({ id: row.id, inboundMessageId: row.inbound_message_id,type: row.type,recordedAt: row.recorded_at.toISOString(),cursor: encode(serviceId,head.generation,row.position) })),
      nextCursor: encode(serviceId,head.generation,end),hasMore, watermark: encode(serviceId,head.generation,head.position),
      retention: { earliestCursor: reset, historyTruncated: head.floor !== "0", days: 90 },
    };
  });
}
