import { diagnosticEvidenceSchema, type MailDiagnostic, type DiagnosticReason, type DiagnosticEvidence } from "@/contracts/mail-diagnostics";
export type Diagnostic = MailDiagnostic;
export function diagnostic(code: Diagnostic["code"], stage: Diagnostic["stage"], options: { source?: Diagnostic["source"]; reasonCode?: DiagnosticReason; evidence?: DiagnosticEvidence; occurredAt?: string | null; detailAvailability?: Diagnostic["detailAvailability"] } = {}): Diagnostic {
    const evidence = diagnosticEvidenceSchema.parse(options.evidence ?? {});
    const reasonCode = options.reasonCode ?? null;
    return { source: options.source ?? "ENVOY", code, reasonCode, stage,
        detailAvailability: reasonCode ? "SPECIFIC" : options.detailAvailability ?? "CATEGORY_ONLY", evidence,
        occurredAt: options.occurredAt === undefined ? new Date().toISOString() : options.occurredAt };
}
