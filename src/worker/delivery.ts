import { createHash } from "node:crypto";
import type { Job } from "bullmq";
import { CanonicalProviderError, type ProviderSendResult } from "@/modules/providers/contracts";
import { loadProviderAccount } from "@/modules/config/provider-account";
import { objectStore } from "@/modules/config/object-store";
import { applyCanonicalEvent } from "@/modules/core/event/service";
import { markAccepted, markDeterminateFailure, markUnknown, prepareSubmission } from "@/modules/core/routing/engine";

export async function processDelivery(job: Job<{ submissionId: string }>) {
  const submission = await prepareSubmission(job.data.submissionId);
  if (!submission || "reconcileAttemptId" in submission) return;
  let account: Awaited<ReturnType<typeof loadProviderAccount>>;
  try {
    account = await loadProviderAccount(submission.providerAccountId);
    account.context.idempotencyKey = submission.providerIdempotencyKey ?? undefined;
    // Verify the immutable accepted file snapshot before entering the provider network boundary.
    for (const [index, file] of submission.attachments.entries()) {
      const bytes = await objectStore().get(file.objectKey);
      if (bytes.byteLength !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("Attachment integrity verification failed");
      submission.message.attachments[index].content = bytes;
    }
  } catch (error) {
    await markDeterminateFailure(submission.attemptId, { category: "policy", code: "LOCAL_PREPARATION_FAILED", stage: "preparation", message: error instanceof Error ? error.message : "Local message preparation failed" }, false);
    return;
  }
  let result: ProviderSendResult;
  try {
    result = await account.module.sender.send(submission.message, account.context);
  } catch (error) {
    if (error instanceof CanonicalProviderError) {
      if (error.outcome !== "not_accepted") { await markUnknown(submission.attemptId, error.message, error); return; }
      await markDeterminateFailure(submission.attemptId, error, error.retryable);
      return;
    }
    // Once send() starts, an unclassified exception cannot prove nonacceptance.
    await markUnknown(submission.attemptId, error instanceof Error ? error.message : "Provider submission outcome is unknown");
    return;
  }
  if (result.outcome === "unknown") { await markUnknown(submission.attemptId, result.reason); return; }
  await markAccepted(submission.attemptId, result.externalMessageId, result.response,result.rfcMessageId ?? null);
  // Acceptance is irreversible; downstream event failures must never trigger failover.
  if (account.module.descriptor.type === "mock") for (const recipient of submission.message.envelopeRecipients ?? [...submission.message.to, ...submission.message.cc, ...submission.message.bcc]) {
    await applyCanonicalEvent(submission.providerAccountId, null, {
      id: crypto.randomUUID(), externalMessageId: result.externalMessageId,
      type: recipient.email.includes("bounce") ? "bounced" : recipient.email.includes("complaint") ? "complained" : "delivered",
      occurredAt: new Date(Date.now() + 100), recipient: recipient.email,
      bounce: recipient.email.includes("bounce") ? { classification: "hard", message: "Simulated hard bounce" } : undefined,
      metadata: {},
    });
  }
}
