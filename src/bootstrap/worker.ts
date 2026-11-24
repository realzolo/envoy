import {
  cancelUnauthorizedReaderDemand,
  deferReaderPreparationDemand,
  pendingReaderResources,
  prepareReaderResource,
  ReaderError
} from "@/modules/mail-reader/public";
import { syncProviderIdentities } from "@/modules/channels/public";
import { purgeExpiredSensitiveContent } from "@/modules/outbound/public";
import { processAttachmentScan, scanPolicy, scheduleAttachmentScans } from "@/modules/attachments/public";
import { randomUUID } from "node:crypto";
import {
  ATTACHMENT_QUEUE,
  CALLBACK_QUEUE,
  closeQueues,
  createQueueWorker,
  DELIVERY_QUEUE,
  EVENT_QUEUE,
  queueSchemaHealth,
  RECONCILIATION_QUEUE
} from "@/platform/queues";
import { cleanupRuntimeStore, removeWorkerHeartbeat, writeWorkerHeartbeat } from "@/platform/runtime-store";
import { dispatchOutboxBatch, markOutboxJobFailed, recoverWorkBatch } from "@/platform/outbox/public";
import { applicationSchemaHealth, db } from "@/platform/database";
import { deadLetterCallback } from "@/modules/callbacks/public";
import { processDelivery } from "@/worker/delivery";
import { processEvent } from "@/worker/event";
import { processCallback } from "@/worker/callback";
import { processReconciliation } from "@/worker/reconciliation";

const MAIL_READER_PREPARATION_BATCH_SIZE = 3;
const MAIL_READER_PREPARATION_INTERVAL_MS = 1_000;

export async function runWorker() {
  await applicationSchemaHealth();
  await queueSchemaHealth();
  const workers = [
    createQueueWorker(ATTACHMENT_QUEUE, job => processAttachmentScan(job.data.resourceId), scanPolicy().concurrency),
    createQueueWorker(DELIVERY_QUEUE, processDelivery, Number(process.env.DELIVERY_CONCURRENCY ?? 10)),
    createQueueWorker(EVENT_QUEUE, processEvent, Number(process.env.EVENT_CONCURRENCY ?? 10)),
    createQueueWorker(CALLBACK_QUEUE, processCallback, Number(process.env.CALLBACK_CONCURRENCY ?? 5)),
    createQueueWorker(RECONCILIATION_QUEUE, processReconciliation, Number(process.env.RECONCILIATION_CONCURRENCY ?? 3)),
  ];
  const workerId = `${process.env.HOSTNAME || "worker"}-${process.pid}-${randomUUID()}`;
  let stopping = false;
  const active = new Set<Promise<unknown>>();
  const timers: ReturnType<typeof setInterval>[] = [];
  const schedule = (name: string, work: () => Promise<unknown>, milliseconds: number) => {
    let running = false;
    const tick = () => {
      if (stopping || running) return;
      running = true;
      const task = work().catch(error => console.error(`${name} error`, error)).finally(() => {
        running = false;
        active.delete(task);
      });
      active.add(task);
    };
    tick();
    timers.push(setInterval(tick, milliseconds));
  };
  for (const worker of workers) {
    worker.on("error", error => console.error("Worker error", error));
    worker.on("failed", (job, error) => {
      if (!job || job.attemptsMade < Number(job.opts.attempts ?? 1)) return;
      const task = (async () => {
        if (worker.name === CALLBACK_QUEUE) await deadLetterCallback((job.data as {
          callbackDeliveryId: string
        }).callbackDeliveryId, error.message);
        if (job.id) await markOutboxJobFailed(job.id, error);
      })().catch(failure => console.error("Failed to record exhausted task", failure)).finally(() => active.delete(task));
      active.add(task);
    });
  }
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    timers.forEach(clearInterval);
    await Promise.allSettled([...active]);
    await Promise.all(workers.map(worker => worker.close()));
    await removeWorkerHeartbeat(workerId);
    await closeQueues();
    await db().end();
  };
  const stop = () => void shutdown().catch(error => {
    console.error("Shutdown error", error);
    process.exitCode = 1;
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await Promise.all(workers.map(worker => worker.waitUntilReady()));
    schedule("Mail reader preparation", async () => {
      const outcomes = await Promise.allSettled((await pendingReaderResources(MAIL_READER_PREPARATION_BATCH_SIZE)).map(async job => {
        try {
          await prepareReaderResource(job);
        } catch (error) {
          if (error instanceof ReaderError && error.status === 404) await cancelUnauthorizedReaderDemand(job);
          else if (error instanceof ReaderError && error.status === 409) await deferReaderPreparationDemand(job);
          else throw error;
        }
      }));
      const failures = outcomes.filter(result => result.status === "rejected").length;
      if (failures) throw new Error(`Mail reader preparation failed for ${failures} resources`);
    }, MAIL_READER_PREPARATION_INTERVAL_MS);
    schedule("Attachment scan scheduler", scheduleAttachmentScans, 1000);
    schedule("Outbox dispatcher", dispatchOutboxBatch, 500);
    schedule("Work recovery", recoverWorkBatch, 30_000);
    schedule("Worker heartbeat", () => writeWorkerHeartbeat(workerId), 15_000);
    schedule("Sensitive content cleanup", purgeExpiredSensitiveContent, 10_000);
    schedule("Runtime cleanup", cleanupRuntimeStore, 60_000);
    schedule("Provider identity sync", syncProviderIdentities, 10_000);
    console.log("Envoy PostgreSQL workers started");
    await Promise.all(workers.map(worker => worker.run()));
  } finally {
    await shutdown();
  }
}

