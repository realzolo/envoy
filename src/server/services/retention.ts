import type { PoolClient } from "pg";
import { objectStore, type ObjectStore } from "@/modules/config/object-store";
import { db } from "@/server/database";
import { cleanupOrphanObjects } from "@/server/services/object-cleanup";

const policies = {
  messages: "ENVOY_RETENTION_CONTENT_DAYS",
  outboundFiles: "ENVOY_RETENTION_CONTENT_DAYS",
  rawEvents: "ENVOY_RETENTION_RAW_DAYS",
  inbound: "ENVOY_RETENTION_INBOUND_DAYS",
  callbacks: "ENVOY_RETENTION_CALLBACK_DAYS",
  requestLogs: "ENVOY_RETENTION_REQUEST_LOG_DAYS",
  auditDetails: "ENVOY_RETENTION_AUDIT_DETAILS_DAYS",
} as const;
export type RetentionCategory = keyof typeof policies;
export type RetentionOptions = { apply: boolean; batchSize: number; days: Partial<Record<RetentionCategory, number>> };
export type RetentionResult = Record<RetentionCategory | "objectDeletions", { enabled: boolean; eligible: number; applied: number; failed: number }>;

export function retentionOptions(env: Partial<NodeJS.ProcessEnv> = process.env, apply = false): RetentionOptions {
  const days: RetentionOptions["days"] = {};
  for (const [category, name] of Object.entries(policies)) {
    const value = env[name];
    if (!value || value === "0") continue;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 36_500) throw new Error(`${name} must be an integer between 1 and 36500 (0 disables cleanup)`);
    days[category as RetentionCategory] = parsed;
  }
  const batchSize = Number(env.ENVOY_RETENTION_BATCH_SIZE ?? 100);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) throw new Error("ENVOY_RETENTION_BATCH_SIZE must be between 1 and 1000");
  return { apply, batchSize, days };
}

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

async function purge(client: PoolClient, category: RetentionCategory, id: string, store?: ObjectStore) {
  if (category === "messages") {
    // Serialize with retry/submit and recheck after locks: pending work must keep its original content.
    await client.query("SELECT id FROM messages WHERE id=$1 FOR UPDATE", [id]);
    await client.query("SELECT id FROM submissions WHERE message_id=$1 ORDER BY id FOR UPDATE", [id]);
    await client.query("SELECT id FROM deliveries WHERE message_id=$1 ORDER BY id FOR UPDATE", [id]);
    const row = await client.query(`SELECT m.id FROM messages m WHERE m.id=$1 AND m.content_purged_at IS NULL AND ${messageSafe} FOR UPDATE`, [id]);
    if (!row.rowCount) return false;
    await client.query(`UPDATE messages SET subject='',html_body=NULL,text_body='',content_purged_at=now() WHERE id=$1`, [id]);
  } else if (category === "outboundFiles") {
    // Acceptance takes FOR SHARE on these rows before committing its message
    // snapshot. Lock first, then recheck references in a fresh statement snapshot.
    await client.query("SELECT id FROM outbound_files WHERE id=$1 FOR UPDATE", [id]);
    const row = await client.query<{ object_key: string }>(`SELECT f.object_key FROM outbound_files f
      WHERE f.id=$1 AND f.content_purged_at IS NULL AND ${fileSafe}`, [id]);
    if (!row.rowCount) return false;
    await (store ?? objectStore()).delete(row.rows[0].object_key);
    await client.query("UPDATE outbound_files SET content_purged_at=now() WHERE id=$1", [id]);
  } else if (category === "rawEvents") {
    const row = await client.query<{ raw_object_key: string | null; receipt_object_key: string | null }>(`SELECT r.raw_object_key,r.verification->>'objectKey' AS receipt_object_key FROM raw_provider_events r
      WHERE r.id=$1 AND r.content_purged_at IS NULL AND (r.processed_at IS NOT NULL OR r.terminated_at IS NOT NULL) AND ${rawSafe} FOR UPDATE`, [id]);
    if (!row.rowCount) return false;
    if (row.rows[0].raw_object_key) await (store ?? objectStore()).delete(row.rows[0].raw_object_key);
    if (row.rows[0].receipt_object_key) await (store ?? objectStore()).delete(row.rows[0].receipt_object_key);
    await client.query("UPDATE raw_provider_events SET raw_body=NULL,raw_object_key=NULL,headers='{}',verification='{}',content_purged_at=now() WHERE id=$1", [id]);
  } else if (category === "inbound") {
    const row = await client.query<{ raw_mime_object_key: string | null }>(`SELECT i.raw_mime_object_key FROM inbound_messages i
      WHERE i.id=$1 AND i.content_purged_at IS NULL AND i.status IN ('ready','rejected') AND ${inboundSafe} FOR UPDATE`, [id]);
    if (!row.rowCount) return false;
    const attachments = await client.query<{ object_key: string }>("SELECT object_key FROM inbound_attachments WHERE inbound_message_id=$1 AND content_purged_at IS NULL FOR UPDATE", [id]);
    for (const attachment of attachments.rows) await (store ?? objectStore()).delete(attachment.object_key);
    if (row.rows[0].raw_mime_object_key) await (store ?? objectStore()).delete(row.rows[0].raw_mime_object_key);
    await client.query("UPDATE inbound_attachments SET content_purged_at=now() WHERE inbound_message_id=$1 AND content_purged_at IS NULL", [id]);
    await client.query("UPDATE inbound_messages SET subject='',sanitized_html=NULL,text_body=NULL,raw_mime_object_key=NULL,content_purged_at=now() WHERE id=$1", [id]);
  } else if (category === "callbacks") {
    const row = await client.query(`SELECT c.id FROM callback_deliveries c WHERE c.id=$1 AND c.payload_purged_at IS NULL AND c.status IN ('delivered','terminated') AND ${callbackSafe} FOR UPDATE`, [id]);
    if (!row.rowCount) return false;
    await client.query("UPDATE callback_deliveries SET payload='{}',payload_purged_at=now() WHERE id=$1", [id]);
  } else if (category === "requestLogs") {
    await client.query("DELETE FROM request_logs WHERE id=$1", [id]);
  } else {
    await client.query("UPDATE audit_logs SET details='{}' WHERE id=$1", [id]);
  }
  return true;
}

export async function runRetention(options: RetentionOptions, store?: ObjectStore): Promise<RetentionResult> {
  const result = {} as RetentionResult;
  const client = await db().connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext('envoy-content-retention')) AS locked");
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) throw new Error("Another retention pass is already running");
    for (const category of Object.keys(policies) as RetentionCategory[]) {
      const days = category === "outboundFiles" ? options.days.outboundFiles ?? options.days.messages : options.days[category];
      const summary = result[category] = { enabled: Boolean(days), eligible: 0, applied: 0, failed: 0 };
      if (!days) continue;
      const candidates = await client.query<{ id: string }>(selections[category], [days, options.batchSize]);
      summary.eligible = candidates.rowCount ?? 0;
      if (!options.apply) continue;
      for (const { id } of candidates.rows) {
        await client.query("BEGIN");
        try {
          const applied = await purge(client, category, id, store);
          await client.query("COMMIT");
          if (applied) summary.applied++;
        } catch (error) {
          await client.query("ROLLBACK");
          summary.failed++;
          console.error("Retention object/record cleanup failed; safe to retry", category, id, error instanceof Error ? error.message : "unknown error");
        }
      }
    }
    if (options.apply) {
      const streams = await client.query<{ service_id: string }>("SELECT service_id FROM inbound_streams s WHERE EXISTS(SELECT 1 FROM inbound_changes c WHERE c.service_id=s.service_id AND c.recorded_at<now()-interval '90 days') ORDER BY service_id LIMIT $1",[options.batchSize]);
      for (const { service_id: serviceId } of streams.rows) {
        await client.query("BEGIN");
        try {
          await client.query("SELECT service_id FROM inbound_streams WHERE service_id=$1 FOR UPDATE",[serviceId]);
          // Never punch holes: retain all positions from the first unexpired record onward.
          await client.query(`WITH prefix AS (
              SELECT position FROM inbound_changes WHERE service_id=$1
                AND position<COALESCE((SELECT min(position) FROM inbound_changes WHERE service_id=$1 AND recorded_at>=clock_timestamp()-interval '90 days'),9223372036854775807)
              ORDER BY position LIMIT $2
            ), boundary AS (
              SELECT COALESCE(max(position),(SELECT floor FROM inbound_streams WHERE service_id=$1)) AS floor FROM prefix
            ), removed AS (DELETE FROM inbound_changes WHERE service_id=$1 AND position<=(SELECT floor FROM boundary) RETURNING position)
            UPDATE inbound_streams SET floor=GREATEST(floor,(SELECT floor FROM boundary)) WHERE service_id=$1`,[serviceId,options.batchSize]);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
      }
    }
    result.objectDeletions = await cleanupOrphanObjects(client, options.apply, options.batchSize, store);
    return result;
  } finally {
    try { if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('envoy-content-retention'))"); }
    finally { client.release(); }
  }
}
