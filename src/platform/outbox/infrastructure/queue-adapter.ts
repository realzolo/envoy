import { queues, type PostgresQueue } from "@/platform/queues";
import type { JobsOptions } from "bullmq";
import type { QueueJobs } from "../application/ports";
import { PROVIDER_EVENT_RECEIVED } from "../events";
export function queueForEvent(eventType: string): PostgresQueue {
    const all = queues();
    if (eventType === "attachment.scan.requested")
        return all.attachments;
    if (eventType === "submission.requested")
        return all.delivery;
    if (eventType === PROVIDER_EVENT_RECEIVED)
        return all.events;
    if (eventType === "callback.requested")
        return all.callbacks;
    if (eventType === "submission.reconcile")
        return all.reconciliation;
    throw new Error(`Unsupported outbox event type: ${eventType}`);
}
export const queueJobs: QueueJobs = {
    async publish(event) {
        const options: JobsOptions = {
            // Replaying after a crash must address the same durable queue job.
            jobId: event.id, attempts: 5, backoff: { type: "exponential", delay: 1000 },
            removeOnComplete: { age: 86400, count: 10000 }, removeOnFail: { age: 604800, count: 10000 },
        };
        await queueForEvent(event.event_type).add(event.event_type, event.payload, options);
    },
    async find(eventType, id) {
        const job = await queueForEvent(eventType).getJob(id);
        return job ? { state: () => job.getState(), remove: () => job.remove() } : null;
    },
};
