import { Queue, Worker, type Processor } from "bullmq";
import { assertSchemaCompatibility, createPostgresBackend, type PostgresQueueBackend } from "bullmq";
import { getDatabaseUrl, db } from "@/server/database";

export const DELIVERY_QUEUE = "envoy-delivery";
export const EVENT_QUEUE = "envoy-events";
export const CALLBACK_QUEUE = "envoy-callbacks";
export const RECONCILIATION_QUEUE = "envoy-reconciliation";
export const QUEUE_SCHEMA = "bullmq";

function connection() {
  const max = Number(process.env.QUEUE_POOL_SIZE ?? 2);
  if (!Number.isInteger(max) || max < 1 || max > 10) throw new Error("QUEUE_POOL_SIZE must be an integer between 1 and 10 per queue backend");
  return {
    connectionString: getDatabaseUrl(), schema: QUEUE_SCHEMA, max, options: "-c timezone=UTC",
    connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000,
    keepAlive: true, keepAliveInitialDelayMillis: 10_000,
    migrate: false,
  };
}

type Payload = Record<string, string>;
export type PostgresQueue = Queue<Payload, unknown, string, Payload, unknown, string, PostgresQueueBackend>;
function createQueue(name: string): PostgresQueue {
  const queue = new Queue<Payload, unknown, string, Payload, unknown, string, PostgresQueueBackend>(name, { connection: connection() }, createPostgresBackend);
  queue.on("error", error => console.error("Queue error", name, error));
  return queue;
}

const globalQueues = globalThis as typeof globalThis & { __envoyQueues?: ReturnType<typeof createQueues> };
function createQueues() {
  return { delivery: createQueue(DELIVERY_QUEUE), events: createQueue(EVENT_QUEUE), callbacks: createQueue(CALLBACK_QUEUE), reconciliation: createQueue(RECONCILIATION_QUEUE) };
}
export function queues() {
  return globalQueues.__envoyQueues ??= createQueues();
}

export function createQueueWorker<T extends Payload>(name: string, processor: Processor<T>, concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) throw new Error(`Invalid concurrency for ${name}`);
  return new Worker<T, unknown, string, PostgresQueueBackend>(name, processor, {
    connection: connection(), concurrency, autorun: false,
    lockDuration: 60_000, stalledInterval: 30_000, maxStalledCount: 2,
  }, createPostgresBackend);
}

export async function queueSchemaHealth() {
  await assertSchemaCompatibility(db(), QUEUE_SCHEMA);
}

export async function closeQueues() {
  const current = globalQueues.__envoyQueues;
  if (!current) return;
  await Promise.all(Object.values(current).map(queue => queue.close()));
  delete globalQueues.__envoyQueues;
}
