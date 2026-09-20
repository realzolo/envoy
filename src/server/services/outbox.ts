import { db, query } from "@/server/database";
import { PROVIDER_EVENT_RECEIVED } from "@/server/outbox-events";
import { queues } from "@/server/queues";

type OutboxRow = {
  id: string;
  event_type: string;
  payload: Record<string, string>;
};

export async function dispatchOutboxBatch(limit = 100) {
  const client = await db().connect();
  const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext('envoy-outbox-dispatcher')) AS locked");
  if (!lock.rows[0]?.locked) {
    client.release();
    return 0;
  }

  let published = 0;
  try {
    const events = await client.query<OutboxRow>(
      `SELECT id, event_type, payload FROM outbox_events
       WHERE status = 'pending' AND available_at <= now() ORDER BY created_at ASC LIMIT $1`,
      [limit],
    );
    const allQueues = queues();
    for (const event of events.rows) {
      try {
        if (event.event_type === "delivery.requested") {
          await allQueues.delivery.add("send", event.payload, {
            jobId: event.id,
            attempts: 5,
            backoff: { type: "exponential", delay: 1_000 },
            removeOnComplete: 1_000,
            removeOnFail: 5_000,
          });
        } else if (event.event_type === PROVIDER_EVENT_RECEIVED || event.event_type === "delivery.suppressed") {
          await allQueues.events.add(event.event_type, event.payload, {
            jobId: event.id,
            attempts: 5,
            backoff: { type: "exponential", delay: 1_000 },
            removeOnComplete: 1_000,
          });
        } else if (event.event_type === "callback.requested") {
          await allQueues.callbacks.add("deliver", event.payload, {
            jobId: event.id,
            attempts: 6,
            backoff: { type: "exponential", delay: 2_000 },
            removeOnComplete: 1_000,
            removeOnFail: 5_000,
          });
        } else if (event.event_type === "delivery.reconcile") {
          await allQueues.reconciliation.add("reconcile", event.payload, {
            jobId: event.id,
            attempts: 8,
            backoff: { type: "exponential", delay: 30_000 },
            removeOnComplete: 1_000,
            removeOnFail: 5_000,
          });
        }
        await client.query(
          "UPDATE outbox_events SET status = 'published', published_at = now(), attempt_count = attempt_count + 1 WHERE id = $1",
          [event.id],
        );
        published += 1;
      } catch (error) {
        await client.query(
          `UPDATE outbox_events SET attempt_count = attempt_count + 1,
           available_at = now() + LEAST(attempt_count + 1, 30) * interval '2 seconds',
           status = CASE WHEN attempt_count >= 20 THEN 'failed' ELSE 'pending' END WHERE id = $1`,
          [event.id],
        );
        console.error("Failed to publish outbox event", event.id, error);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('envoy-outbox-dispatcher'))");
    client.release();
  }
  return published;
}

export async function outboxBacklog() {
  const result = await query<{ count: string }>("SELECT count(*) FROM outbox_events WHERE status = 'pending'");
  return Number(result.rows[0]?.count ?? 0);
}
