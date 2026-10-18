import { withSafeOutboundAttachments } from "@/modules/attachments/access";
import { AttachmentUseError } from "@/modules/attachments/safety";
import type { Job } from "bullmq";
import { CanonicalProviderError, type ProviderSendResult } from "@/modules/providers/contracts";
import { loadProviderAccount } from "@/modules/config/provider-account";
import { applyCanonicalEvent } from "@/modules/core/event/service";
import { markAccepted, markDeterminateFailure, markUnknown, prepareSubmission } from "@/modules/core/routing/engine";

export async function processDelivery(job: Job<{ submissionId: string }>) {
  const submission = await prepareSubmission(job.data.submissionId);
  if (!submission || "reconcileAttemptId" in submission) return;
  let account: Awaited<ReturnType<typeof loadProviderAccount>>;
  let started=false;
  let result: ProviderSendResult | undefined;
  try {
    account = await loadProviderAccount(submission.providerAccountId);
    account.context.idempotencyKey = submission.providerIdempotencyKey ?? undefined;
    await withSafeOutboundAttachments(submission.messageId,submission.attemptId,submission.attachments,async bytes => {
      bytes.forEach((value,index)=>{submission.message.attachments[index].content=value;});
      started=true;
      result=await account.module.sender.send(submission.message,account.context);
    });
  } catch (error) {
    if (!started) {
      await markDeterminateFailure(submission.attemptId, {category:"policy",code:error instanceof AttachmentUseError ? error.code : "LOCAL_PREPARATION_FAILED",stage:"preparation",message:error instanceof AttachmentUseError ? error.reasonCode : "Local message preparation failed"},false);
      return;
    }
    // A read-only guard COMMIT can fail after a definitive provider response; retain that response.
    if (!result) {
      if (error instanceof CanonicalProviderError && error.outcome === "not_accepted") await markDeterminateFailure(submission.attemptId,error,error.retryable);
      else await markUnknown(submission.attemptId,"Provider submission outcome is unknown",error instanceof CanonicalProviderError ? error : undefined);
      return;
    }
  }
  if (!result) return;
  if (result.outcome === "unknown") { await markUnknown(submission.attemptId, result.reason); return; }
  await markAccepted(submission.attemptId, result.externalMessageId, result.response,result.rfcMessageId ?? null);
  // Acceptance is irreversible; downstream event failures must never trigger failover.
  if (account!.module.descriptor.type === "mock") for (const recipient of submission.message.envelopeRecipients ?? [...submission.message.to, ...submission.message.cc, ...submission.message.bcc]) {
    await applyCanonicalEvent(submission.providerAccountId, null, {
      id: crypto.randomUUID(), externalMessageId: result.externalMessageId,
      type: recipient.email.includes("bounce") ? "bounced" : recipient.email.includes("complaint") ? "complained" : "delivered",
      occurredAt: new Date(Date.now() + 100), recipient: recipient.email,
      bounce: recipient.email.includes("bounce") ? { classification: "hard", message: "Simulated hard bounce" } : undefined,
      metadata: {},
    });
  }
}
