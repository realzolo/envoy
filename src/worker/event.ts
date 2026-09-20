import type { Job } from "bullmq";
import { applySuppressedDelivery, processRawProviderEvent } from "@/modules/core/event/service";
import { PROVIDER_EVENT_RECEIVED } from "@/server/outbox-events";

export async function processEvent(job: Job<Record<string, string>>) {
  if (job.name === PROVIDER_EVENT_RECEIVED) await processRawProviderEvent(job.data.rawEventId); else if (job.name === "delivery.suppressed") await applySuppressedDelivery(job.data.deliveryId)
}
