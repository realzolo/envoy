import { pool } from "@/platform/database";
import type { PoolClient } from "pg";
import type { RetentionRepository } from "../application/ports";
import type { RetentionCategory } from "../options";
const terminal = "('delivered','bounced','failed','canceled')";
const messageSafe = `NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.lifecycle_status NOT IN ${terminal})
  AND NOT EXISTS(SELECT 1 FROM submission_attempts a JOIN submissions s ON s.id=a.submission_id
    WHERE s.message_id=m.id AND a.status IN ('submitting','unknown','reconciling')
      AND (a.retry_authorized_at IS NULL OR EXISTS(SELECT 1 FROM deliveries current_delivery
        WHERE current_delivery.current_attempt_id=a.id AND current_delivery.current_submission_id=a.submission_id)))
  AND NOT EXISTS(SELECT 1 FROM callback_deliveries c
    LEFT JOIN delivery_events e ON e.id=c.delivery_event_id LEFT JOIN deliveries d ON d.id=e.delivery_id
    LEFT JOIN submission_events se ON se.id=c.submission_event_id LEFT JOIN submissions s ON s.id=se.submission_id
    WHERE (d.message_id=m.id OR s.message_id=m.id) AND c.status NOT IN ('delivered','terminated'))`;
const fileSafe = `NOT EXISTS(SELECT 1 FROM messages m WHERE m.content_purged_at IS NULL
    AND m.attachment_snapshot @> jsonb_build_array(jsonb_build_object('fileId',f.id)))`;
const rawSafe = `NOT EXISTS(SELECT 1 FROM delivery_events e JOIN deliveries d ON d.id=e.delivery_id
    WHERE e.raw_provider_event_id=r.id AND d.lifecycle_status NOT IN ${terminal})
  AND NOT EXISTS(SELECT 1 FROM submission_events e JOIN submission_deliveries sd ON sd.submission_id=e.submission_id JOIN deliveries d ON d.id=sd.delivery_id
    WHERE e.raw_provider_event_id=r.id AND d.lifecycle_status NOT IN ${terminal})
  AND NOT EXISTS(SELECT 1 FROM submission_attempts a JOIN submission_deliveries sd ON sd.submission_id=a.submission_id
    JOIN delivery_events e ON e.delivery_id=sd.delivery_id
    WHERE e.raw_provider_event_id=r.id AND a.status IN ('submitting','unknown','reconciling')
      AND (a.retry_authorized_at IS NULL OR EXISTS(SELECT 1 FROM deliveries current_delivery
        WHERE current_delivery.current_attempt_id=a.id AND current_delivery.current_submission_id=a.submission_id)))
  AND NOT EXISTS(SELECT 1 FROM submission_events e JOIN submission_attempts a ON a.submission_id=e.submission_id
    WHERE e.raw_provider_event_id=r.id AND a.status IN ('submitting','unknown','reconciling')
      AND (a.retry_authorized_at IS NULL OR EXISTS(SELECT 1 FROM deliveries current_delivery
        WHERE current_delivery.current_attempt_id=a.id AND current_delivery.current_submission_id=a.submission_id)))
  AND NOT EXISTS(SELECT 1 FROM inbound_messages i WHERE i.raw_provider_event_id=r.id AND i.status='scanning')
  AND NOT EXISTS(SELECT 1 FROM callback_deliveries c LEFT JOIN delivery_events e ON e.id=c.delivery_event_id
    LEFT JOIN submission_events se ON se.id=c.submission_event_id LEFT JOIN inbound_messages i ON i.id=c.inbound_message_id
    WHERE c.status NOT IN ('delivered','terminated') AND (e.raw_provider_event_id=r.id OR se.raw_provider_event_id=r.id OR i.raw_provider_event_id=r.id))`;
const inboundSafe = "NOT EXISTS(SELECT 1 FROM callback_deliveries c WHERE c.inbound_message_id=i.id AND c.status NOT IN ('delivered','terminated'))";
const callbackSafe = `NOT EXISTS(SELECT 1 FROM delivery_events e JOIN deliveries d ON d.id=e.delivery_id
  WHERE e.id=c.delivery_event_id AND d.lifecycle_status NOT IN ${terminal})
  AND NOT EXISTS(SELECT 1 FROM submission_events e JOIN submission_deliveries sd ON sd.submission_id=e.submission_id JOIN deliveries d ON d.id=sd.delivery_id
    WHERE e.id=c.submission_event_id AND d.lifecycle_status NOT IN ${terminal})
  AND NOT EXISTS(SELECT 1 FROM submission_attempts a JOIN submission_deliveries sd ON sd.submission_id=a.submission_id
    JOIN delivery_events e ON e.delivery_id=sd.delivery_id WHERE e.id=c.delivery_event_id
      AND a.status IN ('submitting','unknown','reconciling')
      AND (a.retry_authorized_at IS NULL OR EXISTS(SELECT 1 FROM deliveries current_delivery
        WHERE current_delivery.current_attempt_id=a.id AND current_delivery.current_submission_id=a.submission_id)))
  AND NOT EXISTS(SELECT 1 FROM submission_events e JOIN submission_attempts a ON a.submission_id=e.submission_id
    WHERE e.id=c.submission_event_id AND a.status IN ('submitting','unknown','reconciling')
      AND (a.retry_authorized_at IS NULL OR EXISTS(SELECT 1 FROM deliveries current_delivery
        WHERE current_delivery.current_attempt_id=a.id AND current_delivery.current_submission_id=a.submission_id)))`;
const selections: Record<RetentionCategory, string> = {
    messages: `SELECT m.id FROM messages m WHERE m.content_purged_at IS NULL AND m.accepted_at<now()-$1*interval '1 day' AND ${messageSafe} ORDER BY m.accepted_at,m.id LIMIT $2`,
    outboundFiles: `SELECT f.id FROM outbound_files f WHERE f.content_purged_at IS NULL AND f.created_at<now()-$1*interval '1 day'
    AND ${fileSafe} ORDER BY f.created_at,f.id LIMIT $2`,
    rawEvents: `SELECT r.id FROM raw_provider_events r WHERE r.content_purged_at IS NULL AND (r.processed_at IS NOT NULL OR r.terminated_at IS NOT NULL)
    AND r.received_at<now()-$1*interval '1 day' AND ${rawSafe} ORDER BY r.received_at,r.id LIMIT $2`,
    inbound: `SELECT i.id FROM inbound_messages i WHERE i.content_purged_at IS NULL AND i.status IN ('ready','rejected')
    AND GREATEST(i.created_at,COALESCE(i.ready_at,i.created_at))<now()-$1*interval '1 day' AND ${inboundSafe} ORDER BY GREATEST(i.created_at,COALESCE(i.ready_at,i.created_at)),i.id LIMIT $2`,
    callbacks: `SELECT c.id FROM callback_deliveries c WHERE c.payload_purged_at IS NULL AND c.status IN ('delivered','terminated')
    AND COALESCE(c.terminated_at,c.delivered_at)<now()-$1*interval '1 day' AND ${callbackSafe} ORDER BY c.delivered_at,c.id LIMIT $2`,
    requestLogs: "SELECT id::text FROM request_logs WHERE created_at<now()-$1*interval '1 day' ORDER BY created_at,id LIMIT $2",
    auditDetails: "SELECT id::text FROM audit_logs WHERE details<>'{}'::jsonb AND created_at<now()-$1*interval '1 day' ORDER BY created_at,id LIMIT $2",
};
function retentionRepository(client: PoolClient): RetentionRepository {
    return {
        lockMessage(id: string) { return client.query<Record<string, unknown>>("SELECT id FROM messages WHERE id=$1 FOR UPDATE", [id]); },
        lockMessageSubmissions(id: string) { return client.query<Record<string, unknown>>("SELECT id FROM submissions WHERE message_id=$1 ORDER BY id FOR UPDATE", [id]); },
        lockMessageDeliveries(id: string) { return client.query<Record<string, unknown>>("SELECT id FROM deliveries WHERE message_id=$1 ORDER BY id FOR UPDATE", [id]); },
        findPurgeableMessage(id: string) { return client.query<Record<string, unknown>>(`SELECT m.id FROM messages m WHERE m.id=$1 AND m.content_purged_at IS NULL AND ${messageSafe} FOR UPDATE`, [id]); },
        purgeMessage(id: string) { return client.query<Record<string, unknown>>(`UPDATE messages SET sensitive_content=NULL,sensitive_content_purged_at=COALESCE(sensitive_content_purged_at,clock_timestamp()),subject='',html_body=NULL,text_body='',content_purged_at=now() WHERE id=$1`, [id]); },
        lockOutboundFile(id: string) { return client.query<Record<string, unknown>>("SELECT id FROM outbound_files WHERE id=$1 FOR UPDATE", [id]); },
        findPurgeableFile(id: string) {
            return client.query<{
                object_key: string;
            }>(`SELECT f.object_key FROM outbound_files f
      WHERE f.id=$1 AND f.content_purged_at IS NULL AND ${fileSafe}`, [id]);
        },
        purgeFile(id: string) { return client.query<Record<string, unknown>>("UPDATE outbound_files SET content_purged_at=now() WHERE id=$1", [id]); },
        findPurgeableProviderEvent(id: string) {
            return client.query<{
                raw_object_key: string | null;
                receipt_object_key: string | null;
            }>(`SELECT r.raw_object_key,r.verification->>'objectKey' AS receipt_object_key FROM raw_provider_events r
      WHERE r.id=$1 AND r.content_purged_at IS NULL AND (r.processed_at IS NOT NULL OR r.terminated_at IS NOT NULL) AND ${rawSafe} FOR UPDATE`, [id]);
        },
        purgeProviderEvent(id: string) { return client.query<Record<string, unknown>>("UPDATE raw_provider_events SET normalized_events=NULL,raw_body=NULL,raw_object_key=NULL,headers='{}',verification='{}',content_purged_at=now() WHERE id=$1", [id]); },
        findPurgeableInbound(id: string) {
            return client.query<{
                raw_mime_object_key: string | null;
            }>(`SELECT i.raw_mime_object_key FROM inbound_messages i
      WHERE i.id=$1 AND i.content_purged_at IS NULL AND i.status IN ('ready','rejected') AND ${inboundSafe} FOR UPDATE`, [id]);
        },
        listPurgeableInboundAttachments(id: string) { return client.query<{
            object_key: string;
        }>("SELECT object_key FROM inbound_attachments WHERE inbound_message_id=$1 AND content_purged_at IS NULL FOR UPDATE", [id]); },
        purgeInboundAttachments(id: string) { return client.query<Record<string, unknown>>("UPDATE inbound_attachments SET content_purged_at=now() WHERE inbound_message_id=$1 AND content_purged_at IS NULL", [id]); },
        purgeInbound(id: string) { return client.query<Record<string, unknown>>("UPDATE inbound_messages SET subject='',sanitized_html=NULL,text_body=NULL,raw_mime_object_key=NULL,content_purged_at=now() WHERE id=$1", [id]); },
        findPurgeableCallback(id: string) { return client.query<Record<string, unknown>>(`SELECT c.id FROM callback_deliveries c WHERE c.id=$1 AND c.payload_purged_at IS NULL AND c.status IN ('delivered','terminated') AND ${callbackSafe} FOR UPDATE`, [id]); },
        purgeCallback(id: string) { return client.query<Record<string, unknown>>("UPDATE callback_deliveries SET payload='{}',payload_purged_at=now() WHERE id=$1", [id]); },
        deleteRequestLog(id: string) { return client.query<Record<string, unknown>>("DELETE FROM request_logs WHERE id=$1", [id]); },
        purgeAuditDetails(id: string) { return client.query<Record<string, unknown>>("UPDATE audit_logs SET details='{}' WHERE id=$1", [id]); },
        listExpiredStreams(limit: number) { return client.query<{
            service_id: string;
        }>("SELECT service_id FROM inbound_streams s WHERE EXISTS(SELECT 1 FROM inbound_changes c WHERE c.service_id=s.service_id AND c.recorded_at<now()-interval '90 days') ORDER BY service_id LIMIT $1", [limit]); },
        lockStream(serviceId: string) { return client.query<Record<string, unknown>>("SELECT service_id FROM inbound_streams WHERE service_id=$1 FOR UPDATE", [serviceId]); },
        pruneStream(serviceId: string, limit: number) {
            return client.query<Record<string, unknown>>(`WITH prefix AS (
              SELECT position FROM inbound_changes WHERE service_id=$1
                AND position<COALESCE((SELECT min(position) FROM inbound_changes WHERE service_id=$1 AND recorded_at>=clock_timestamp()-interval '90 days'),9223372036854775807)
              ORDER BY position LIMIT $2
            ), boundary AS (
              SELECT COALESCE(max(position),(SELECT floor FROM inbound_streams WHERE service_id=$1)) AS floor FROM prefix
            ), removed AS (DELETE FROM inbound_changes WHERE service_id=$1 AND position<=(SELECT floor FROM boundary) RETURNING position)
            UPDATE inbound_streams SET floor=GREATEST(floor,(SELECT floor FROM boundary)) WHERE service_id=$1`, [serviceId, limit]);
        },
        selectCandidates(category, days, limit) { return client.query<{
            id: string;
        }>(selections[category], [days, limit]); },
        async transaction(work) { await client.query("BEGIN"); try {
            const result = await work(retentionRepository(client));
            await client.query("COMMIT");
            return result;
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } }
    };
}
export const retentionSession = { async run<T>(work: (repository: RetentionRepository) => Promise<T>): Promise<T> {
        const client = await pool().connect();
        let locked = false;
        try {
            locked = Boolean((await client.query<{
                locked: boolean;
            }>("SELECT pg_try_advisory_lock(hashtext('envoy-content-retention')) AS locked")).rows[0]?.locked);
            if (!locked)
                throw new Error("Another retention pass is already running");
            return await work(retentionRepository(client));
        }
        finally {
            try {
                if (locked)
                    await client.query("SELECT pg_advisory_unlock(hashtext('envoy-content-retention'))");
            }
            finally {
                client.release();
            }
        }
    } };
