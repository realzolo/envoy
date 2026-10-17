import { markReconciled, recordWorkflowFailure } from "@/modules/core/routing/engine";
import { createId } from "@/server/ids";
import { db } from "@/server/database";
import { PROVIDER_EVENT_RECEIVED } from "@/server/outbox-events";
import { queueForEvent } from "@/server/services/outbox";

let recoveryCursor: { type: string; id: string } | undefined;

type Work = { aggregate_type: string; aggregate_id: string; event_type: string; payload: Record<string, string>; expired_submission: boolean; reset_raw: boolean };

// A bounded repair pass complements BullMQ locks/retries; business status remains authoritative.
export async function recoverWorkBatch(limit = 100) {
  const client = await db().connect();
  let locked = false;
  let recovered = 0;
  try {
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext('envoy-work-recovery')) AS locked");
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return 0;
    // The final claim itself can crash before recording exhaustion. Close that lease once due.
    const exhausted = await client.query<{ id: string }>(`SELECT a.id FROM submission_attempts a
      WHERE a.status IN ('unknown','reconciling') AND a.reconciliation_count>=12 AND a.reconcile_after<=now()
        AND EXISTS(SELECT 1 FROM submission_deliveries sd JOIN deliveries d ON d.id=sd.delivery_id
          WHERE sd.submission_id=a.submission_id AND d.current_attempt_id=a.id)
      ORDER BY a.reconcile_after,a.id LIMIT $1`, [limit]);
    for (const attempt of exhausted.rows) await markReconciled(attempt.id, "unknown");
    await client.query(`UPDATE raw_provider_events SET processing_error=COALESCE(processing_error,'Processing attempts exhausted; manual replay required')
      WHERE id IN(SELECT id FROM raw_provider_events WHERE processed_at IS NULL AND processing_attempt_count>=20
        AND next_attempt_at<=now() AND processing_error IS NULL LIMIT $1)`, [limit]);
    const candidates = await client.query<Work>(
      `SELECT * FROM (
        SELECT 'submission'::text AS aggregate_type,s.id AS aggregate_id,'submission.requested'::text AS event_type,
          jsonb_build_object('submissionId',s.id) AS payload,(s.status='submitting') AS expired_submission,false AS reset_raw
        FROM submissions s LEFT JOIN submission_attempts a ON a.id=s.current_attempt_id
        WHERE ((s.status IN ('queued','deferred') AND s.updated_at<now()-interval '2 minutes')
          OR (s.status='submitting' AND a.status='submitting' AND a.submission_deadline_at<=now()))
        UNION ALL
        SELECT 'attempt',a.id,'submission.reconcile',jsonb_build_object('attemptId',a.id),false,false
        FROM submission_attempts a WHERE a.status IN ('unknown','reconciling') AND a.reconcile_after<=now()
          AND EXISTS(SELECT 1 FROM submission_deliveries sd JOIN deliveries d ON d.id=sd.delivery_id
            WHERE sd.submission_id=a.submission_id AND d.current_attempt_id=a.id)
        UNION ALL
        SELECT 'raw_provider_event',r.id,$2,jsonb_build_object('rawEventId',r.id),false,(r.processed_at IS NOT NULL)
        FROM raw_provider_events r WHERE (r.processed_at IS NULL OR EXISTS(SELECT 1 FROM inbound_messages i
          WHERE i.raw_provider_event_id=r.id AND i.status='scanning' AND (i.processing_deadline_at IS NULL OR i.processing_deadline_at<=now())))
          AND r.next_attempt_at<=now() AND r.processing_attempt_count<20 AND r.content_purged_at IS NULL AND r.terminated_at IS NULL
          AND r.received_at<now()-interval '2 minutes'
        UNION ALL
        SELECT 'callback',c.id,'callback.requested',jsonb_build_object('callbackDeliveryId',c.id),false,false
        FROM callback_deliveries c WHERE c.status IN ('pending','retrying','delivering')
          AND c.next_attempt_at<=now() AND c.updated_at<now()-interval '2 minutes'
      ) work WHERE ($3::text IS NULL OR (aggregate_type,aggregate_id)>($3,$4)) AND NOT EXISTS (
        SELECT 1 FROM outbox_events o WHERE o.aggregate_type=work.aggregate_type AND o.aggregate_id=work.aggregate_id
          AND o.event_type=work.event_type AND o.status='pending'
      ) ORDER BY aggregate_type,aggregate_id LIMIT $1`,
      [Math.max(1, Math.min(limit, 500)), PROVIDER_EVENT_RECEIVED, recoveryCursor?.type ?? null, recoveryCursor?.id ?? null],
    );
    if (!candidates.rowCount) recoveryCursor = undefined;
    for (const work of candidates.rows) {
      // Advance even across healthy/failed jobs so a busy queue cannot starve later missing work.
      recoveryCursor = { type: work.aggregate_type, id: work.aggregate_id };
      const previous = await client.query<{ id: string; status: string; recent: boolean }>(
        `SELECT id,status,created_at>now()-interval '2 minutes' AS recent FROM outbox_events
         WHERE aggregate_type=$1 AND aggregate_id=$2 AND event_type=$3 ORDER BY created_at DESC LIMIT 1`,
        [work.aggregate_type, work.aggregate_id, work.event_type],
      );
      const latest = previous.rows[0];
      // Exhausted tasks remain visible until an operator retries them; never restart a poison task forever.
      if (latest?.status === "failed") {
        // Heal a crash after the failed outbox marker committed but before its
        // public workflow diagnostic was recorded. The event key is idempotent.
        if (work.event_type === "submission.requested") await recordWorkflowFailure(work.payload.submissionId, "The task exhausted infrastructure retries. Review the failed task before resuming.");
        continue;
      }
      if (latest?.recent) continue;
      if (latest && !work.expired_submission) {
        const job = await queueForEvent(work.event_type).getJob(latest.id);
        const state = job ? await job.getState() : "unknown";
        if (["active", "waiting", "delayed", "prioritized", "waiting-children"].includes(state)) continue;
        if (state === "failed") {
          await client.query("UPDATE outbox_events SET status='failed' WHERE id=$1", [latest.id]);
          if (work.event_type === "submission.requested") await recordWorkflowFailure(work.payload.submissionId, "The worker task exhausted its infrastructure retries. Review the failed task before resuming.");
          continue;
        }
      }
      // The dispatcher and processors may race this snapshot. Stable business IDs and processor locks make replay safe.
      await client.query("BEGIN");
      try {
        if (work.reset_raw) await client.query("UPDATE raw_provider_events SET processed_at=NULL,next_attempt_at=now() WHERE id=$1 AND content_purged_at IS NULL", [work.aggregate_id]);
        await client.query(
        `INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload)
         VALUES ($1,$2,$3,$4,$5)`,
        [createId("out"), work.aggregate_type, work.aggregate_id, work.event_type, work.payload],
      );
        await client.query("COMMIT");
        recovered++;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return recovered;
  } finally {
    try { if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('envoy-work-recovery'))"); }
    finally { client.release(); }
  }
}
