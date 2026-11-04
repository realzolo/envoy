import { diagnosticEvidenceSchema, projectDiagnostic } from "@/contracts/mail-diagnostics";
import { safeReason, smtpFacts, submissionReason } from "./diagnostic-facts";
import type { CanonicalEvent } from "@/integrations/providers/contracts";
const outboundTypes = new Set(["accepted", "deferred", "delivered", "bounced", "failed", "opened", "clicked", "complained", "unsubscribed", "suppressed"]);
/** No free text from provider echoes; sufficient to associate and replay a late delivery fact. */
export function contentFreeOutboundEvents(events: CanonicalEvent[]): CanonicalEvent[] | null {
    if (!events.length || !events.every(event => outboundTypes.has(event.type) && event.externalMessageId && Number.isFinite(event.occurredAt.getTime())))
        return null;
    return events.map(event => ({ id: event.id, externalMessageId: event.externalMessageId, type: event.type,
        recipient: event.recipient, occurredAt: event.occurredAt,
        ...(event.bounce ? { bounce: { classification: event.bounce.classification } } : {}), metadata: {
          ...(event.metadata.diagnostic ? { diagnostic: projectDiagnostic(event.metadata.diagnostic) } : {}),
          reasonCode: safeReason(event.metadata.reasonCode) ?? submissionReason(event.metadata.providerCode),
          evidence: diagnosticEvidenceSchema.parse({ ...smtpFacts([event.bounce?.code, event.bounce?.message, event.metadata.smtpStatus]).evidence, ...(event.metadata.evidence && typeof event.metadata.evidence === "object" ? event.metadata.evidence : {}), ...(event.bounce ? { bounceClass: event.bounce.classification } : {}) }),
        } }));
}
