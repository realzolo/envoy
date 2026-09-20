import { loadEnvConfig } from "@next/env";
import { type Job, Worker } from "bullmq";
import { CALLBACK_QUEUE, closeQueues, DELIVERY_QUEUE, EVENT_QUEUE, RECONCILIATION_QUEUE } from "@/server/queues";
import { createWorkerRedis } from "@/server/redis";
import { dispatchOutboxBatch } from "@/server/services/outbox";
import { db } from "@/server/database";
import { deadLetterCallback } from "@/modules/callbacks/service";
import { processDelivery } from "./delivery";
import { processEvent } from "./event";
import { processCallback } from "./callback";
import { processReconciliation } from "./reconciliation";

loadEnvConfig(process.cwd());

async function main() {
  const connections = [createWorkerRedis(), createWorkerRedis(), createWorkerRedis(), createWorkerRedis()];
  const workers = [new Worker(DELIVERY_QUEUE, processDelivery, {
    connection: connections[0],
    concurrency: Number(process.env.DELIVERY_CONCURRENCY ?? 10)
  }), new Worker(EVENT_QUEUE, processEvent, {
    connection: connections[1],
    concurrency: Number(process.env.EVENT_CONCURRENCY ?? 10)
  }), new Worker(CALLBACK_QUEUE, processCallback, {
    connection: connections[2],
    concurrency: Number(process.env.CALLBACK_CONCURRENCY ?? 5)
  }), new Worker(RECONCILIATION_QUEUE, processReconciliation, {
    connection: connections[3],
    concurrency: Number(process.env.RECONCILIATION_CONCURRENCY ?? 3)
  })];
  workers[2].on("failed", (job, error) => {
    if (job && job.attemptsMade >= Number(job.opts.attempts ?? 1)) void deadLetterCallback((job as Job<{
      callbackDeliveryId: string
    }>).data.callbackDeliveryId, error.message)
  });
  for (const worker of workers) worker.on("error", error => console.error("Worker error", error));
  const dispatcher = setInterval(() => void dispatchOutboxBatch(), 500);
  await dispatchOutboxBatch();
  console.log("Envoy workers started");
  const shutdown = async () => {
    clearInterval(dispatcher);
    await Promise.all(workers.map(worker => worker.close()));
    await Promise.all(connections.map(connection => connection.quit()));
    await closeQueues();
    await db().end();
    process.exit(0)
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown)
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1
});
