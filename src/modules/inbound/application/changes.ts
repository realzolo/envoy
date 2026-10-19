import type { UnitOfWork } from "@/platform/transactions";

export class InboundCursorError extends Error {
  constructor(public code: "INVALID_INBOUND_CURSOR" | "INBOUND_CURSOR_EXPIRED", public resetCursor?: string) { super(code); }
}
const encode = (service: string, generation: string, position: string) => Buffer.from(JSON.stringify({ service, generation, position })).toString("base64url");
export interface InboundChangesRepository {
  ensureStream(serviceId: string): Promise<void>;
  lockHead(serviceId: string): Promise<{ generation: string; position: string; floor: string }>;
  readPrefix(serviceId: string, after: string, head: string, limit: number): Promise<{ id: string; position: string; inboundMessageId: string; type: string; recordedAt: Date }[]>;
}

export function createInboundChanges(unitOfWork: UnitOfWork<InboundChangesRepository>) {
  return async function listInboundChanges(serviceId: string, limit: number, cursor?: string | null) {
    return unitOfWork.run(async repo => {
      await repo.ensureStream(serviceId);
      const head = await repo.lockHead(serviceId);
      let after = head.floor;
      const reset = encode(serviceId, head.generation, head.floor);
      if (cursor) {
        let parsed;
        try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()); } catch { throw new InboundCursorError("INVALID_INBOUND_CURSOR"); }
        if (!parsed || typeof parsed !== "object" || parsed.service !== serviceId || typeof parsed.position !== "string" || !/^\d{1,19}$/.test(parsed.position)) throw new InboundCursorError("INVALID_INBOUND_CURSOR");
        if (parsed.generation !== head.generation || BigInt(parsed.position) < BigInt(head.floor)) throw new InboundCursorError("INBOUND_CURSOR_EXPIRED", reset);
        if (BigInt(parsed.position) > BigInt(head.position)) throw new InboundCursorError("INVALID_INBOUND_CURSOR");
        after = parsed.position;
      }
      const rows = await repo.readPrefix(serviceId, after, head.position, limit + 1), hasMore = rows.length > limit, data = rows.slice(0, limit);
      const end = hasMore ? data.at(-1)!.position : head.position;
      return {
        data: data.map(row => ({ id: row.id, inboundMessageId: row.inboundMessageId, type: row.type, recordedAt: row.recordedAt.toISOString(), cursor: encode(serviceId, head.generation, row.position) })),
        nextCursor: encode(serviceId, head.generation, end), hasMore, watermark: encode(serviceId, head.generation, head.position),
        retention: { earliestCursor: reset, historyTruncated: head.floor !== "0", days: 90 },
      };
    });
  };
}
