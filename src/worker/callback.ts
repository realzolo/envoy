import type { Job } from "bullmq";
import { deliverCallback } from "@/modules/callbacks/service";

export async function processCallback(job: Job<{ callbackDeliveryId: string }>) {
  await deliverCallback(job.data.callbackDeliveryId)
}
