import type { Job } from "bullmq";
import { loadProviderAccount } from "@/modules/config/provider-account";
import { getAttemptForReconciliation, markReconciled } from "@/modules/core/routing/engine";

export async function processReconciliation(job: Job<{ attemptId: string }>) {
  const attempt = await getAttemptForReconciliation(job.data.attemptId);
  if (!attempt || !["unknown", "reconciling"].includes(attempt.status)) return;
  const account = await loadProviderAccount(attempt.provider_account_id, { allowNonActive: true });
  if (!account.module.reconciliation) {
    await markReconciled(attempt.id, "unknown");
    return
  }
  const outcome = await account.module.reconciliation.reconcile(attempt.external_message_id, attempt.request_fingerprint, account.context);
  await markReconciled(attempt.id, outcome)
}
