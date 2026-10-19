import { pool, query, transaction } from "@/platform/database";
import type { PoolClient } from "pg";
import type { DispatchRepository, ExclusiveSession, OutboxReadRepository, OutboxRetryRepository, RecoveryRepository } from "../application/ports";
import type { OutboxEvent, PreviousOutboxWork, RecoverableWork } from "../contracts";
import { PROVIDER_EVENT_RECEIVED } from "../events";
function dispatchRepository(client: PoolClient): DispatchRepository {
    return {
        async listPending(limit) {
            return (await client.query<OutboxEvent>(`SELECT id,event_type,payload FROM outbox_events
       WHERE status='pending' AND available_at<=now() ORDER BY available_at,created_at LIMIT $1`, [limit])).rows;
        },
        async markPublished(id) { await client.query("UPDATE outbox_events SET status='published',published_at=now(),attempt_count=attempt_count+1 WHERE id=$1", [id]); },
        async recordPublicationFailure(id) {
            return (await client.query<{
                status: "failed" | "pending";
            }>(`UPDATE outbox_events SET attempt_count=attempt_count+1,
           available_at=now()+LEAST(attempt_count+1,30)*interval '2 seconds',
           status=CASE WHEN attempt_count+1>=20 THEN 'failed' ELSE 'pending' END WHERE id=$1 RETURNING status`, [id])).rows[0].status;
        },
    };
}
export const outboxReads: OutboxReadRepository = {
    async countPending() { return Number((await query<{
        count: string;
    }>("SELECT count(*) FROM outbox_events WHERE status='pending' AND available_at<=now()")).rows[0]?.count ?? 0); },
    async markExhaustedPublishedJob(id) { const row = (await query<{
        event_type: string;
        payload: Record<string, string>;
    }>("UPDATE outbox_events SET status='failed' WHERE id=$1 AND status='published' RETURNING event_type,payload", [id])).rows[0]; return row ? { ...row, id } : null; },
};
function recoveryRepository(client: PoolClient): RecoveryRepository {
    return {
        async listExhaustedReconciliations(limit) {
            return (await client.query<{
                id: string;
            }>(`SELECT a.id FROM submission_attempts a
      WHERE a.status IN ('unknown','reconciling') AND a.reconciliation_count>=12 AND a.reconcile_after<=now()
        AND EXISTS(SELECT 1 FROM submission_deliveries sd JOIN deliveries d ON d.id=sd.delivery_id
          WHERE sd.submission_id=a.submission_id AND d.current_attempt_id=a.id)
      ORDER BY a.reconcile_after,a.id LIMIT $1`, [limit])).rows;
        },
        async markExhaustedProviderEvents(limit) {
            await client.query(`UPDATE raw_provider_events SET processing_error=COALESCE(processing_error,'Processing attempts exhausted; manual replay required')
      WHERE id IN(SELECT id FROM raw_provider_events WHERE processed_at IS NULL AND processing_attempt_count>=20
        AND next_attempt_at<=now() AND processing_error IS NULL LIMIT $1)`, [limit]);
        },
        async listRecoverableWork(limit, cursor) {
            return (await client.query<RecoverableWork>(`SELECT * FROM (
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
      ) ORDER BY aggregate_type,aggregate_id LIMIT $1`, [limit, PROVIDER_EVENT_RECEIVED, cursor?.type ?? null, cursor?.id ?? null])).rows;
        },
        async findLatestWork(work) {
            return (await client.query<PreviousOutboxWork>(`SELECT id,status,created_at>now()-interval '2 minutes' AS recent FROM outbox_events
         WHERE aggregate_type=$1 AND aggregate_id=$2 AND event_type=$3 ORDER BY created_at DESC LIMIT 1`, [work.aggregate_type, work.aggregate_id, work.event_type])).rows[0] ?? null;
        },
        async markFailed(id) { await client.query("UPDATE outbox_events SET status='failed' WHERE id=$1", [id]); },
        async restoreWork(work, outboxId) {
            await client.query("BEGIN");
            try {
                if (work.reset_raw)
                    await client.query("UPDATE raw_provider_events SET processed_at=NULL,next_attempt_at=now() WHERE id=$1 AND content_purged_at IS NULL", [work.aggregate_id]);
                await client.query(`INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload)
         VALUES ($1,$2,$3,$4,$5)`, [outboxId, work.aggregate_type, work.aggregate_id, work.event_type, work.payload]);
                await client.query("COMMIT");
            }
            catch (error) {
                await client.query("ROLLBACK");
                throw error;
            }
        },
    };
}
function exclusive<Repository>(name: string, factory: (client: PoolClient) => Repository): ExclusiveSession<Repository> {
    return { async run(work) {
            const client = await pool().connect();
            let locked = false;
            try {
                locked = Boolean((await client.query<{
                    locked: boolean;
                }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [name])).rows[0]?.locked);
                if (!locked)
                    return null;
                return await work(factory(client));
            }
            finally {
                try {
                    if (locked)
                        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [name]);
                }
                finally {
                    client.release();
                }
            }
        } };
}
export const dispatchSession = exclusive("envoy-outbox-dispatcher", dispatchRepository);
export const recoverySession = exclusive("envoy-work-recovery", recoveryRepository);
export const retryUnitOfWork = { run<T>(work: (repository: OutboxRetryRepository) => Promise<T>) {
        return transaction(client => work({
            async lockFailed(id) { return (await client.query<{
                event_type: string;
            }>("SELECT event_type FROM outbox_events WHERE id=$1 AND status='failed' FOR UPDATE", [id])).rows[0] ?? null; },
            async resetFailed(id) { await client.query("UPDATE outbox_events SET status='pending',attempt_count=0,available_at=now() WHERE id=$1", [id]); },
            async auditRetry(id, actor) { await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id) VALUES ($1,'outbox.retry','outbox_event',$2)", [actor, id]); },
        }));
    } };
