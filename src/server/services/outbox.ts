import type { JobsOptions } from "bullmq";
import { db, query } from "@/server/database";
import { PROVIDER_EVENT_RECEIVED } from "@/server/outbox-events";
import { queues, type PostgresQueue } from "@/server/queues";

export type OutboxRow = { id: string; event_type: string; payload: Record<string, string> };

export function queueForEvent(eventType: string): PostgresQueue {
  const all = queues();
  if (eventType === "delivery.requested") return all.delivery;
  if (eventType === PROVIDER_EVENT_RECEIVED || eventType === "delivery.suppressed") return all.events;
  if (eventType === "callback.requested") return all.callbacks;
  if (eventType === "delivery.reconcile") return all.reconciliation;
  throw new Error(`Unsupported outbox event type: ${eventType}`);
}

export async function dispatchOutboxBatch(limit = 100) {
  const client = await db().connect();
  let locked = false;
  let published = 0;
  try {
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext('envoy-outbox-dispatcher')) AS locked");
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return 0;
    const events = await client.query<OutboxRow>(
      `SELECT id,event_type,payload FROM outbox_events
       WHERE status='pending' AND available_at<=now() ORDER BY available_at,created_at LIMIT $1`,
      [Math.max(1, Math.min(limit, 500))],
    );
    for (const event of events.rows) {
      try {
        const options: JobsOptions = {
          // A crash after add() commits but before UPDATE must replay this same queue identity.
          jobId: event.id, attempts: 5, backoff: { type: "exponential", delay: 1_000 },
          removeOnComplete: { age: 86_400, count: 10_000 }, removeOnFail: { age: 604_800, count: 10_000 },
        };
        await queueForEvent(event.event_type).add(event.event_type, event.payload, options);
        await client.query(
          "UPDATE outbox_events SET status='published',published_at=now(),attempt_count=attempt_count+1 WHERE id=$1", [event.id],
        );
        published++;
      } catch (error) {
        await client.query(
          `UPDATE outbox_events SET attempt_count=attempt_count+1,
           available_at=now()+LEAST(attempt_count+1,30)*interval '2 seconds',
           status=CASE WHEN attempt_count+1>=20 THEN 'failed' ELSE 'pending' END WHERE id=$1`, [event.id],
        );
        console.error("Failed to publish outbox event", event.id, error);
      }
    }
    return published;
  } finally {
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('envoy-outbox-dispatcher'))");
    } finally { client.release(); }
  }
}

export async function outboxBacklog() {
  const result = await query<{ count: string }>("SELECT count(*) FROM outbox_events WHERE status='pending' AND available_at<=now()");
  return Number(result.rows[0]?.count ?? 0);
}

export async function markOutboxJobFailed(jobId: string, error: Error) {
  await query("UPDATE outbox_events SET status='failed' WHERE id=$1 AND status='published'", [jobId]);
  console.error("Task exhausted queue retries", jobId, error.message);
}
