import { markReconciled, recordWorkflowFailure } from "@/modules/outbound/public";
import { createId } from "@/platform/ids";
import { createRecoveryService } from "@/platform/outbox/application/recovery";
import { createOutboxService } from "@/platform/outbox/application/service";
import { dispatchSession, outboxReads, recoverySession, retryUnitOfWork } from "@/platform/outbox/infrastructure/outbox.repository";
import { queueJobs } from "@/platform/outbox/infrastructure/queue-adapter";
const dependencies = { dispatch: dispatchSession, recovery: recoverySession, reads: outboxReads, retries: retryUnitOfWork,
    jobs: queueJobs, recordWorkflowFailure, markReconciled, createId,
    log: (message: string, ...details: unknown[]) => console.error(message, ...details) };
export const outbox = { ...createOutboxService(dependencies), recoverWorkBatch: createRecoveryService(dependencies) };
