import type { UnitOfWork } from "@/platform/transactions";

export class OutboundCursorError extends Error {
  constructor(public code: "INVALID_OUTBOUND_CURSOR" | "OUTBOUND_CURSOR_EXPIRED", public resetCursor?: string) { super(code); }
}
const encode = (service: string, generation: string, position: string) => Buffer.from(JSON.stringify({ service, generation, position })).toString("base64url");
export interface OutboundChangesRepository {
  ensureStream(serviceId: string): Promise<void>;
  lockHead(serviceId: string): Promise<{ generation: string; position: string; floor: string }>;
  readPrefix(serviceId: string, after: string, head: string, limit: number): Promise<{ id: string; position: string; messageId: string; type: string; recordedAt: Date }[]>;
}

export function createOutboundChanges(unitOfWork: UnitOfWork<OutboundChangesRepository>) {
  return async function listOutboundChanges(serviceId: string, limit: number, cursor?: string | null) {
    return unitOfWork.run(async repo => {
      await repo.ensureStream(serviceId);
      const head = await repo.lockHead(serviceId);
      let after = head.floor;
      const reset = encode(serviceId, head.generation, head.floor);
      if (cursor) {
        let parsed;
        try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()); } catch { throw new OutboundCursorError("INVALID_OUTBOUND_CURSOR", reset); }
        if (!parsed || typeof parsed !== "object" || parsed.service !== serviceId || typeof parsed.generation !== "string" || !parsed.generation || typeof parsed.position !== "string" || !/^\d{1,19}$/.test(parsed.position)) throw new OutboundCursorError("INVALID_OUTBOUND_CURSOR", reset);
        if (parsed.generation !== head.generation || BigInt(parsed.position) < BigInt(head.floor)) throw new OutboundCursorError("OUTBOUND_CURSOR_EXPIRED", reset);
        if (BigInt(parsed.position) > BigInt(head.position)) throw new OutboundCursorError("INVALID_OUTBOUND_CURSOR", reset);
        after = parsed.position;
      }
      const rows = await repo.readPrefix(serviceId, after, head.position, limit + 1), hasMore = rows.length > limit, data = rows.slice(0, limit);
      const end = hasMore ? data.at(-1)!.position : head.position;
      return {
        data: data.map(row => ({ id: row.id, messageId: row.messageId, type: row.type, recordedAt: row.recordedAt.toISOString(), cursor: encode(serviceId, head.generation, row.position) })),
        nextCursor: encode(serviceId, head.generation, end), hasMore, watermark: encode(serviceId, head.generation, head.position),
        retention: { earliestCursor: reset, historyTruncated: head.floor !== "0", days: 90 },
      };
    });
  };
}
