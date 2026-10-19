import { deliverSubmission } from "@/modules/outbound/public";
import type { Job } from "bullmq";
export async function processDelivery(job: Job<{
    submissionId: string;
}>) {
    await deliverSubmission(job.data.submissionId);
}
