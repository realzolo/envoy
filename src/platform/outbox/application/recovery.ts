import type { RecoveryCursor } from "../contracts";
import type { OutboxDependencies } from "./ports";
export function createRecoveryService(dependencies: OutboxDependencies) {
    let recoveryCursor: RecoveryCursor | undefined;
    return async function recoverWorkBatch(limit = 100): Promise<number> {
        return await dependencies.recovery.run(async (repository) => {
            let recovered = 0;
            for (const attempt of await repository.listExhaustedReconciliations(limit))
                await dependencies.markReconciled(attempt.id, "unknown");
            await repository.markExhaustedProviderEvents(limit);
            const candidates = await repository.listRecoverableWork(Math.max(1, Math.min(limit, 500)), recoveryCursor);
            if (!candidates.length)
                recoveryCursor = undefined;
            for (const work of candidates) {
                // Healthy or exhausted work must not starve later missing tasks.
                recoveryCursor = { type: work.aggregate_type, id: work.aggregate_id };
                const latest = await repository.findLatestWork(work);
                if (latest?.status === "failed") {
                    if (work.event_type === "submission.requested")
                        await dependencies.recordWorkflowFailure(work.payload.submissionId, "The task exhausted infrastructure retries. Review the failed task before resuming.");
                    continue;
                }
                if (latest?.recent)
                    continue;
                if (latest && !work.expired_submission) {
                    const job = await dependencies.jobs.find(work.event_type, latest.id);
                    const state = job ? await job.state() : "unknown";
                    if (["active", "waiting", "delayed", "prioritized", "waiting-children"].includes(state))
                        continue;
                    if (state === "failed") {
                        await repository.markFailed(latest.id);
                        if (work.event_type === "submission.requested")
                            await dependencies.recordWorkflowFailure(work.payload.submissionId, "The worker task exhausted its infrastructure retries. Review the failed task before resuming.");
                        continue;
                    }
                }
                // Stable business identifiers and processor locks make racing replay safe.
                await repository.restoreWork(work, dependencies.createId("out"));
                recovered++;
            }
            return recovered;
        }) ?? 0;
    };
}
