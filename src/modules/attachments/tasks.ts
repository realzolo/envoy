import { MAX_FILE_BYTES } from "@/lib/contracts";
import type { PoolClient } from "pg";
import { transaction } from "@/server/database";
import { createId } from "@/server/ids";
import { objectStore } from "@/modules/config/object-store";
import { digest, scanBytes, scanPolicy } from "./scanner";
import { AttachmentUseError } from "./safety";

type Task = { resource_id: string; kind: "outbound" | "inbound"; service_id: string | null; expected_sha256: string; attempt_count: number; lease_token: string };
/** Same lock order as erasure: inbound parent, resource, safety. */
export async function lockAttachment(client: PoolClient, id: string, kind: Task["kind"], share = false) {
  const lock = share ? "FOR SHARE" : "FOR UPDATE";
  if (kind === "inbound") await client.query(`SELECT i.id FROM inbound_messages i JOIN inbound_attachments a ON a.inbound_message_id=i.id WHERE a.id=$1 ${lock} OF i`,[id]);
  return (await client.query<{object_key:string;sha256:string;size_bytes:string;content_purged_at:Date|null}>(
    `SELECT object_key,sha256,size_bytes,content_purged_at FROM ${kind === "outbound" ? "outbound_files" : "inbound_attachments"} WHERE id=$1 ${lock}`,[id])).rows[0];
}

/** Persistent round-robin scopes cap each owner to one queued/live scan. New scopes cannot sit behind a large upload batch. */
export async function scheduleAttachmentScans(limit = scanPolicy().concurrency) {
  const policy = scanPolicy();
  return transaction(async client => {
    await client.query(`UPDATE attachment_safety SET status='unavailable',reason='SCAN_RETRIES_EXHAUSTED',lease_token=NULL,lease_expires_at=NULL,queued_until=NULL
      WHERE status='scanning' AND lease_expires_at<=now() AND attempt_count>=5`);
    await client.query(`UPDATE attachment_safety s SET status='unavailable',reason='SCAN_TASK_FAILED',attempt_count=5,queued_until=NULL
      WHERE s.outbox_id IS NOT NULL AND s.status IN ('pending','unavailable') AND EXISTS(SELECT 1 FROM outbox_events o WHERE o.id=s.outbox_id AND o.status='failed')`);
    const due = `s.status NOT IN ('malicious','blocked','purged') AND s.next_attempt_at<=now()
      AND (s.queued_until IS NULL OR s.queued_until<=now()) AND (s.lease_expires_at IS NULL OR s.lease_expires_at<=now())
      AND ((s.status<>'clean' AND s.attempt_count<5) OR s.policy_version IS DISTINCT FROM $1)`;
    const scopes = (await client.query<{scope:string}>(`SELECT scope FROM attachment_scan_scopes f
      WHERE EXISTS(SELECT 1 FROM attachment_safety s WHERE s.scope=f.scope AND ${due})
        AND NOT EXISTS(SELECT 1 FROM attachment_safety live WHERE live.scope=f.scope AND (live.queued_until>now() OR live.lease_expires_at>now()))
      ORDER BY last_dispatched_at,scope LIMIT $2 FOR UPDATE SKIP LOCKED`,[policy.version,Math.max(1,Math.min(limit,16))])).rows;
    let count = 0;
    for (const {scope} of scopes) {
      // Recheck in a fresh snapshot after acquiring the scope lock: another scheduler may have just committed.
      if ((await client.query("SELECT 1 FROM attachment_safety WHERE scope=$1 AND (queued_until>now() OR lease_expires_at>now()) LIMIT 1",[scope])).rowCount) continue;
      const task = (await client.query<Task>(`SELECT s.* FROM attachment_safety s WHERE s.scope=$2 AND ${due} ORDER BY next_attempt_at,resource_id LIMIT 1 FOR UPDATE`,[policy.version,scope])).rows[0];
      if (!task) continue;
      const outboxId = createId("out");
      await client.query(`UPDATE attachment_safety SET queued_until=now()+interval '2 minutes',outbox_id=$2,
        attempt_count=CASE WHEN policy_version IS DISTINCT FROM $3 THEN 0 ELSE attempt_count END,policy_version=$3,status='pending',updated_at=now() WHERE resource_id=$1`,[task.resource_id,outboxId,policy.version]);
      await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'attachment',$2,'attachment.scan.requested',$3)",[outboxId,task.resource_id,{resourceId:task.resource_id}]);
      await client.query("UPDATE attachment_scan_scopes SET last_dispatched_at=clock_timestamp() WHERE scope=$1",[scope]);
      count++;
    }
    return count;
  });
}

export async function processAttachmentScan(resourceId: string) {
  const policy = scanPolicy(), token = createId("scan");
  const task = await transaction(async client => (await client.query<Task>(`UPDATE attachment_safety SET status='scanning',attempt_count=attempt_count+1,
    lease_token=$2,lease_expires_at=now()+interval '2 minutes',updated_at=now(),policy_version=$3
    WHERE resource_id=$1 AND status NOT IN ('malicious','blocked','purged') AND next_attempt_at<=now()
      AND attempt_count<5 AND (lease_expires_at IS NULL OR lease_expires_at<=now())
      AND NOT(status='clean' AND policy_version=$3) RETURNING *`,[resourceId,token,policy.version])).rows[0]);
  if (!task) return;
  let sourceKey:string|undefined;
  let status = "unavailable", reason: string | null = "FILE_STORAGE_UNAVAILABLE", sha256: string | null = null;
  try {
    const source = await transaction(client => lockAttachment(client,resourceId,task.kind,true));
    if (!source || source.content_purged_at) { status="purged";reason="FILE_CONTENT_PURGED"; }
    else {
      sourceKey=source.object_key;
      const bytes = await objectStore().get(source.object_key,MAX_FILE_BYTES);
      sha256 = digest(bytes);
      if (bytes.byteLength !== Number(source.size_bytes) || source.sha256 !== sha256 || task.expected_sha256 !== sha256) {
        status="blocked";reason="FILE_INTEGRITY_FAILED";
      } else { const result = await scanBytes(bytes);status=result.status;reason=result.reason; }
    }
  } catch { /* Store/network details and object keys must not enter job logs or public diagnostics. */ }
  await transaction(async client => {
    const source = await lockAttachment(client,resourceId,task.kind);
    const row = (await client.query<Task>("SELECT * FROM attachment_safety WHERE resource_id=$1 AND lease_token=$2 FOR UPDATE",[resourceId,token])).rows[0];
    if (!row) return; // A later claim or erasure fences this result.
    if (!source || source.content_purged_at) {status="purged";reason="FILE_CONTENT_PURGED";}
    if (source && sourceKey && source.object_key!==sourceKey) {status="blocked";reason="FILE_INTEGRITY_FAILED";}
    if (source && sha256 && source.sha256!==sha256) {status="blocked";reason="FILE_INTEGRITY_FAILED";}
    if (policy.version !== scanPolicy().version && status === "clean") {status="unavailable";reason="FILE_SCAN_REQUIRED";}
    await client.query(`UPDATE attachment_safety SET status=$3,reason=$4,scanned_sha256=$5,
      checked_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,queued_until=NULL,
      next_attempt_at=now()+LEAST(30*power(2,attempt_count-1),600)*interval '1 second',updated_at=now() WHERE resource_id=$1 AND lease_token=$2`,[resourceId,token,status,reason,sha256]);
  });
}

/** Service ownership is established from the resource, never from caller-supplied task metadata. */
export async function retryAttachmentScan(id:string,kind:Task["kind"],serviceId:string|null,actor:string) {
  return transaction(async client => {
    if (serviceId !== null) {
      const owned = await client.query(kind === "outbound" ? "SELECT id FROM outbound_files WHERE id=$1 AND service_id=$2" : "SELECT a.id FROM inbound_attachments a JOIN inbound_messages i ON i.id=a.inbound_message_id WHERE a.id=$1 AND i.service_id=$2",[id,serviceId]);
      if (!owned.rowCount) return null;
    }
    const file = await lockAttachment(client,id,kind);
    if (!file) return null;
    const row = (await client.query<{status:string;lease_expires_at:Date|null;queued_until:Date|null}>("SELECT * FROM attachment_safety WHERE resource_id=$1 AND kind=$2 FOR UPDATE",[id,kind])).rows[0];
    if (!row || file.content_purged_at || ['malicious','blocked','purged'].includes(row.status)) throw new AttachmentUseError("FILE_UNAVAILABLE","FILE_REPROCESSING_FORBIDDEN");
    if ((row.lease_expires_at && row.lease_expires_at.getTime()>Date.now()) || (row.queued_until && row.queued_until.getTime()>Date.now())) return {id,processing:true};
    await client.query("UPDATE attachment_safety SET status='pending',reason=NULL,attempt_count=0,next_attempt_at=now(),outbox_id=NULL,queued_until=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE resource_id=$1",[id]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id) VALUES($1,'attachment.reprocess','attachment',$2)",[actor,id]);
    return {id,processing:true};
  });
}
