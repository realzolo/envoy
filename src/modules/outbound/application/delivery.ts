import { CanonicalProviderError, type ProviderSendResult } from "@/integrations/providers/contracts";
import type { DeliverySubmission } from "../contracts";
import { SendDeadlineError } from "../domain/deadline";
import { SendPreparationError } from "../domain/submission-error";
import type { createEventsService } from "./events";
import type { createRoutingService } from "./routing";
type DeliveryDependencies = Pick<ReturnType<typeof createRoutingService>, "prepareSubmission" | "markAccepted" | "markDeterminateFailure" | "markUnknown"> & Pick<ReturnType<typeof createEventsService>, "applyCanonicalEvent"> & {
    sender: {
        send(submission: DeliverySubmission): Promise<ProviderSendResult>;
    };
};
export function createDeliveryWorkflow(dependencies: DeliveryDependencies) {
    return async function deliverSubmission(submissionId: string): Promise<void> {
        const submission = await dependencies.prepareSubmission(submissionId);
        if (!submission || "reconcileAttemptId" in submission)
            return;
        let result: ProviderSendResult;
        try {
            result = await dependencies.sender.send(submission);
        }
        catch (error) {
            if (error instanceof SendPreparationError)
                await dependencies.markDeterminateFailure(submission.attemptId, { category: "policy", code: error.code, stage: "preparation", message: error.message }, false);
            else if (error instanceof SendDeadlineError)
                await dependencies.markDeterminateFailure(submission.attemptId, { category: "policy", code: error.code, message: error.message }, false);
            else if (error instanceof CanonicalProviderError && error.outcome === "not_accepted")
                await dependencies.markDeterminateFailure(submission.attemptId, error, error.retryable);
            else
                await dependencies.markUnknown(submission.attemptId, "Provider submission outcome is unknown", error instanceof CanonicalProviderError ? error : undefined);
            return;
        }
        if (result.outcome === "unknown") {
            await dependencies.markUnknown(submission.attemptId, result.reason);
            return;
        }
        await dependencies.markAccepted(submission.attemptId, result.externalMessageId, result.response, result.rfcMessageId ?? null);
        // Acceptance is irreversible. Subsequent receipt processing cannot authorize provider failover.
        if (submission.providerType === "mock")
            for (const recipient of submission.message.envelopeRecipients ?? [...submission.message.to, ...submission.message.cc, ...submission.message.bcc]) {
                await dependencies.applyCanonicalEvent(submission.providerAccountId, null, {
                    id: crypto.randomUUID(), externalMessageId: result.externalMessageId,
                    type: recipient.email.includes("bounce") ? "bounced" : recipient.email.includes("complaint") ? "complained" : "delivered",
                    occurredAt: new Date(Date.now() + 100), recipient: recipient.email,
                    bounce: recipient.email.includes("bounce") ? { classification: "hard", message: "Simulated hard bounce" } : undefined,
                    metadata: {},
                });
            }
    };
}
