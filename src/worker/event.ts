import type { Job } from "bullmq";
import { processRawProviderEvent } from "@/modules/outbound/public";
import { PROVIDER_EVENT_RECEIVED } from "@/platform/outbox/events";

export async function processEvent(job: Job<Record<string, string>>) {
  if (job.name !== PROVIDER_EVENT_RECEIVED) throw new Error(`Unsupported provider event job: ${job.name}`);
  await processRawProviderEvent(job.data.rawEventId);
}
