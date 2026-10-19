import type { ProviderSendResult } from "@/integrations/providers/contracts";
import { runWithSubmissionPolicy } from "@/integrations/providers/submission-policy";
import { AttachmentUseError, withSafeOutboundAttachments } from "@/modules/attachments/public";
import { loadProviderAccount } from "@/modules/channels/public";
import type { DeliverySubmission } from "../contracts";
import { SendDeadlineError } from "../domain/deadline";
import { SendPreparationError } from "../domain/submission-error";
export const providerSender = {
    async send(submission: DeliverySubmission): Promise<ProviderSendResult> {
        let started = false;
        let result: ProviderSendResult | undefined;
        try {
            const account = await loadProviderAccount(submission.providerAccountId);
            account.context.idempotencyKey = submission.providerIdempotencyKey ?? undefined;
            await withSafeOutboundAttachments(submission.messageId, submission.attemptId, submission.attachments, async (bytes, beforeSend) => {
                bytes.forEach((value, index) => { submission.message.attachments[index].content = value; });
                started = true;
                result = await runWithSubmissionPolicy({ sendBefore: submission.sendBefore, sensitive: submission.sensitive, beforeSend }, () => account.module.sender.send(submission.message, account.context));
            });
        }
        catch (error) {
            // The attachment guard can fail to COMMIT after a definitive network response.
            // Preserve that response rather than converting provider acceptance into a retry.
            if (result)
                return result;
            if (!started)
                throw new SendPreparationError(error instanceof SendDeadlineError || error instanceof AttachmentUseError ? error.code : "LOCAL_PREPARATION_FAILED", error instanceof SendDeadlineError ? error.message : error instanceof AttachmentUseError ? error.reasonCode : "Local message preparation failed");
            throw error;
        }
        if (!result)
            throw new SendPreparationError("LOCAL_PREPARATION_FAILED", "Local message preparation did not invoke the provider");
        return result;
    },
};
export const providerReconciler = {
    async reconcile(attempt: {
        provider_account_id: string;
        external_message_id: string | null;
        request_fingerprint: string;
    }): Promise<"accepted" | "not_accepted" | "unknown"> {
        const account = await loadProviderAccount(attempt.provider_account_id, { allowNonActive: true });
        if (!account.module.reconciliation)
            return "unknown";
        return account.module.reconciliation.reconcile(attempt.external_message_id, attempt.request_fingerprint, account.context);
    },
};
