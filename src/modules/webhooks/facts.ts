import type { CanonicalEvent } from "@/modules/providers/contracts";

const outboundTypes = new Set(["accepted", "deferred", "delivered", "bounced", "failed", "opened", "clicked", "complained", "unsubscribed", "suppressed"]);
/** No free text from provider echoes; sufficient to associate and replay a late delivery fact. */
export function contentFreeOutboundEvents(events: CanonicalEvent[]): CanonicalEvent[] | null {
  if (!events.length || !events.every(event => outboundTypes.has(event.type) && event.externalMessageId && Number.isFinite(event.occurredAt.getTime()))) return null;
  return events.map(event => ({ id: event.id, externalMessageId: event.externalMessageId, type: event.type,
    recipient: event.recipient, occurredAt: event.occurredAt,
    ...(event.bounce ? { bounce: { classification: event.bounce.classification } } : {}), metadata: {} }));
}
