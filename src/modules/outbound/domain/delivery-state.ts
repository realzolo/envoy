import type { DeliveryStateEvent } from "../contracts";
export const lifecycleTypes = ["queued", "submitting", "unknown", "accepted", "deferred", "delivered", "bounced", "failed", "canceled"];
const rank: Readonly<Record<string, number>> = { queued: 0, submitting: 1, unknown: 2, deferred: 3, accepted: 4, failed: 5, delivered: 6, bounced: 7, canceled: 8 };
const terminalStatuses = new Set(["delivered", "bounced", "failed", "canceled"]);
/** Late provider facts cannot regress terminal states; equal timestamps use a stable precedence. */
export function shouldProjectLifecycle(currentStatus: string, event: Pick<DeliveryStateEvent, "type" | "occurredAt">, previous?: {
    event_type: string;
    occurred_at: Date;
}, force = false): boolean {
    const terminal = terminalStatuses.has(currentStatus);
    const incomingTerminal = terminalStatuses.has(event.type);
    const chronological = !previous || previous.occurred_at < event.occurredAt ||
        (previous.occurred_at.getTime() === event.occurredAt.getTime() && rank[event.type] > rank[previous.event_type]);
    const conclusiveAcceptance = event.type === "accepted" && ["queued", "submitting", "unknown"].includes(currentStatus);
    return force || conclusiveAcceptance || (incomingTerminal && !terminal) || (chronological && (!terminal || incomingTerminal));
}
