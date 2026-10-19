import type { UnitOfWork } from "@/platform/transactions";
import type { OutboxEvent, PreviousOutboxWork, RecoverableWork, RecoveryCursor } from "../contracts";
export interface ExclusiveSession<Repository> {
    run<T>(work: (repository: Repository) => Promise<T>): Promise<T | null>;
}
export interface DispatchRepository {
    listPending(limit: number): Promise<OutboxEvent[]>;
    markPublished(id: string): Promise<void>;
    recordPublicationFailure(id: string): Promise<"failed" | "pending">;
}
export interface OutboxReadRepository {
    countPending(): Promise<number>;
    markExhaustedPublishedJob(id: string): Promise<OutboxEvent | null>;
}
export interface OutboxRetryRepository {
    lockFailed(id: string): Promise<{
        event_type: string;
    } | null>;
    resetFailed(id: string): Promise<void>;
    auditRetry(id: string, actor: string): Promise<void>;
}
export interface RecoveryRepository {
    listExhaustedReconciliations(limit: number): Promise<{
        id: string;
    }[]>;
    markExhaustedProviderEvents(limit: number): Promise<void>;
    listRecoverableWork(limit: number, cursor?: RecoveryCursor): Promise<RecoverableWork[]>;
    findLatestWork(work: RecoverableWork): Promise<PreviousOutboxWork | null>;
    markFailed(id: string): Promise<void>;
    restoreWork(work: RecoverableWork, outboxId: string): Promise<void>;
}
export interface QueueJobs {
    publish(event: OutboxEvent): Promise<void>;
    find(eventType: string, id: string): Promise<{
        state(): Promise<string>;
        remove(): Promise<void>;
    } | null>;
}
export interface OutboxDependencies {
    dispatch: ExclusiveSession<DispatchRepository>;
    recovery: ExclusiveSession<RecoveryRepository>;
    reads: OutboxReadRepository;
    retries: UnitOfWork<OutboxRetryRepository>;
    jobs: QueueJobs;
    recordWorkflowFailure(submissionId: string, message: string): Promise<void>;
    markReconciled(attemptId: string, outcome: "unknown"): Promise<void>;
    createId(prefix: string): string;
    log(message: string, ...details: unknown[]): void;
}
