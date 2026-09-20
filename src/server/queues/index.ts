import { Queue } from "bullmq";
import { createWorkerRedis } from "@/server/redis";

export const DELIVERY_QUEUE = "envoy-delivery";
export const EVENT_QUEUE = "envoy-events";
export const CALLBACK_QUEUE = "envoy-callbacks";
export const RECONCILIATION_QUEUE = "envoy-reconciliation";

const globalQueues = globalThis as typeof globalThis & {
  __envoyQueues?: {
    connection: ReturnType<typeof createWorkerRedis>;
    delivery: Queue;
    events: Queue;
    callbacks: Queue;
    reconciliation: Queue;
  };
};

export function queues() {
  if (!globalQueues.__envoyQueues) {
    const connection = createWorkerRedis();
    globalQueues.__envoyQueues = {
      connection,
      delivery: new Queue(DELIVERY_QUEUE, { connection }),
      events: new Queue(EVENT_QUEUE, { connection }),
      callbacks: new Queue(CALLBACK_QUEUE, { connection }),
      reconciliation: new Queue(RECONCILIATION_QUEUE, { connection }),
    };
  }
  return globalQueues.__envoyQueues;
}

export async function closeQueues() {
  if (!globalQueues.__envoyQueues) return;
  await Promise.all([
    globalQueues.__envoyQueues.delivery.close(),
    globalQueues.__envoyQueues.events.close(),
    globalQueues.__envoyQueues.callbacks.close(),
    globalQueues.__envoyQueues.reconciliation.close(),
  ]);
  await globalQueues.__envoyQueues.connection.quit();
  delete globalQueues.__envoyQueues;
}
