import type { createRoutingService } from "./routing";
type ReconciliationDependencies = Pick<ReturnType<typeof createRoutingService>, "getAttemptForReconciliation" | "markReconciled"> & {
    reconciler: {
        reconcile(attempt: {
            provider_account_id: string;
            external_message_id: string | null;
            request_fingerprint: string;
        }): Promise<"accepted" | "not_accepted" | "unknown">;
    };
};
export function createReconciliationWorkflow(dependencies: ReconciliationDependencies) {
    return async function reconcileAttempt(attemptId: string): Promise<void> {
        const attempt = await dependencies.getAttemptForReconciliation(attemptId);
        if (!attempt || !["unknown", "reconciling"].includes(attempt.status))
            return;
        try {
            await dependencies.markReconciled(attempt.id, await dependencies.reconciler.reconcile(attempt));
        }
        catch {
            await dependencies.markReconciled(attempt.id, "unknown");
        }
    };
}
