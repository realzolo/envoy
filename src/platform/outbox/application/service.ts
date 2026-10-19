import type { OutboxDependencies } from "./ports";
export function createOutboxService(dependencies: OutboxDependencies) {
    async function dispatchOutboxBatch(limit = 100): Promise<number> {
        return await dependencies.dispatch.run(async (repository) => {
            let published = 0;
            for (const event of await repository.listPending(Math.max(1, Math.min(limit, 500)))) {
                try {
                    await dependencies.jobs.publish(event);
                    await repository.markPublished(event.id);
                    published++;
                }
                catch (error) {
                    const status = await repository.recordPublicationFailure(event.id);
                    if (status === "failed" && event.event_type === "submission.requested")
                        await dependencies.recordWorkflowFailure(event.payload.submissionId, error instanceof Error ? error.message : "Queue publication failed");
                    dependencies.log("Failed to publish outbox event", event.id, error);
                }
            }
            return published;
        }) ?? 0;
    }
    async function outboxBacklog() { return dependencies.reads.countPending(); }
    async function markOutboxJobFailed(jobId: string, error: Error) {
        const event = await dependencies.reads.markExhaustedPublishedJob(jobId);
        if (event?.event_type === "submission.requested")
            await dependencies.recordWorkflowFailure(event.payload.submissionId, error.message);
        dependencies.log("Task exhausted queue retries", jobId, error.message);
    }
    async function retryOutbox(id: string, actor: string) {
        return dependencies.retries.run(async (repository) => {
            const row = await repository.lockFailed(id);
            if (!row)
                throw new Error("Failed work not found; refresh its current state.");
            const job = await dependencies.jobs.find(row.event_type, id);
            if (job) {
                if (await job.state() === "active")
                    throw new Error("This work is still executing. Wait for it to finish.");
                // A retained failed job must be removed before reusing its stable Outbox identity.
                // A crash leaves the failed Outbox record available for the same authorized retry.
                await job.remove();
            }
            await repository.resetFailed(id);
            await repository.auditRetry(id, actor);
            return { id };
        });
    }
    return { dispatchOutboxBatch, outboxBacklog, markOutboxJobFailed, retryOutbox };
}
