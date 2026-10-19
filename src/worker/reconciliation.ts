import { reconcileAttempt } from "@/modules/outbound/public";
import type { Job } from "bullmq";
export async function processReconciliation(job: Job<{
    attemptId: string;
}>) {
    await reconcileAttempt(job.data.attemptId);
}
