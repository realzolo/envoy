import { deliverySnapshotSchema, projectDiagnostic, retryDispositionSchema, type DeliverySnapshot } from "@/contracts/mail-diagnostics";
const iso = (value: unknown): string | null => value == null ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
/** Public/admin readers consume the same complete row and validated projection. */
export function projectDeliverySnapshot(row: Record<string, unknown>): DeliverySnapshot {
    const lifecycle = row.lifecycle_status;
    return deliverySnapshotSchema.parse({ id: row.id ?? row.delivery_id, messageId: row.message_id, revision: String(row.revision),
        submissionId: row.current_submission_id, attemptId: row.current_attempt_id, lifecycle,
        outcome: lifecycle === "delivered" ? "succeeded" : lifecycle === "unknown" ? "unknown" : lifecycle === "canceled" ? "canceled" : ["failed", "bounced"].includes(String(lifecycle)) ? "failed" : "pending",
        acceptedAt: iso(row.provider_accepted_at !== undefined ? row.provider_accepted_at : row.accepted_at), deliveredAt: iso(row.delivered_at),
        diagnostic: projectDiagnostic(row.diagnostic), retryDisposition: retryDispositionSchema.parse(row.retry_disposition), observedAt: new Date().toISOString() });
}
