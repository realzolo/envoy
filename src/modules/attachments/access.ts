import { transaction } from "@/server/database";
import { objectStore } from "@/modules/config/object-store";
import { MAX_FILE_BYTES } from "@/lib/contracts";
import { lockAttachment } from "./tasks";
import { assertUsable, attachmentUsage, AttachmentUseError, type SafetyRow } from "./safety";
import { digest } from "./scanner";
import type { AttachmentSnapshot } from "@/modules/files/service";

class ByteAccessError extends AttachmentUseError {
  constructor(public id:string,public kind:"outbound"|"inbound",reason:string) {super("FILE_UNAVAILABLE",reason);}
}
async function rememberFailure(error:unknown) {
  if (!(error instanceof ByteAccessError)) throw error;
  await transaction(async client=>{
    const file=await lockAttachment(client,error.id,error.kind);
    if (!file || file.content_purged_at) return;
    await client.query(`UPDATE attachment_safety SET status=$2,reason=$3,attempt_count=0,next_attempt_at=now(),
      lease_token=NULL,lease_expires_at=NULL,queued_until=NULL,updated_at=now()
      WHERE resource_id=$1 AND status NOT IN ('malicious','blocked','purged')`,[error.id,error.reasonCode==="FILE_INTEGRITY_FAILED" ? "blocked" : "unavailable",error.reasonCode]);
  });
  throw error;
}

/** Keep content and safety locks through the provider boundary; load/check EVERY attachment before send(). */
export async function withSafeOutboundAttachments<T>(messageId:string,attemptId:string,files:AttachmentSnapshot[],send:(bytes:Uint8Array[])=>Promise<T>) {
  return transaction(async client => {
    const owner = (await client.query<{service_id:string;content_purged_at:Date|null}>("SELECT service_id,content_purged_at FROM messages WHERE id=$1 FOR SHARE",[messageId])).rows[0];
    if (!owner || owner.content_purged_at) throw new AttachmentUseError("FILE_UNAVAILABLE","FILE_CONTENT_PURGED");
    const loaded = new Map<string,Uint8Array>();
    for (const file of [...files].sort((a,b)=>a.fileId.localeCompare(b.fileId))) {
      const row = (await client.query<{sha256:string;object_key:string;size_bytes:string;content_purged_at:Date|null}>("SELECT sha256,object_key,size_bytes,content_purged_at FROM outbound_files WHERE id=$1 AND service_id=$2 FOR SHARE",[file.fileId,owner.service_id])).rows[0];
      const safety = (await client.query<SafetyRow>("SELECT * FROM attachment_safety WHERE resource_id=$1 FOR SHARE",[file.fileId])).rows[0];
      assertUsable(Boolean(row && !row.content_purged_at),row?.sha256 ?? null,safety);
      if (row.sha256!==file.sha256 || row.object_key!==file.objectKey || Number(row.size_bytes)!==file.size) throw new ByteAccessError(file.fileId,"outbound","FILE_INTEGRITY_FAILED");
      let bytes:Uint8Array;
      try {bytes=await objectStore().get(row.object_key,MAX_FILE_BYTES);}catch {throw new ByteAccessError(file.fileId,"outbound","FILE_STORAGE_UNAVAILABLE");}
      if (digest(bytes)!==file.sha256 || bytes.byteLength!==file.size) throw new ByteAccessError(file.fileId,"outbound","FILE_INTEGRITY_FAILED");
      loaded.set(file.fileId,bytes);
    }
    // Re-evaluate policy after I/O, immediately before entering the provider network boundary.
    for (const file of files) {
      const safety=(await client.query<SafetyRow>("SELECT * FROM attachment_safety WHERE resource_id=$1",[file.fileId])).rows[0];
      assertUsable(true,file.sha256,safety);
    }
    // Preparation may have waited on storage. Never start a stale/expired attempt's network operation.
    // The message lock serializes recovery/cancellation; use wall-clock time, not BEGIN's timestamp.
    const live = await client.query(`SELECT a.id FROM submission_attempts a JOIN submissions s ON s.id=a.submission_id
      WHERE a.id=$1 AND s.message_id=$2 AND s.current_attempt_id=a.id AND s.status='submitting'
        AND a.status='submitting' AND a.submission_deadline_at>clock_timestamp() FOR SHARE OF a,s`,[attemptId,messageId]);
    if (!live.rowCount) throw new Error("Submission preparation lease is no longer valid");
    return send(files.map(file=>loaded.get(file.fileId)!));
  }).catch(rememberFailure);
}

export async function downloadAttachment(kind:"outbound"|"inbound",id:string,serviceId?:string,parentId?:string) {
  return transaction(async client => {
    const found = kind === "outbound" ? await client.query<{file_name:string;sha256:string;content_purged_at:Date|null}>("SELECT file_name,sha256,content_purged_at FROM outbound_files WHERE id=$1 AND service_id=$2",[id,serviceId])
      : await client.query<{file_name:string;sha256:string;content_purged_at:Date|null}>(`SELECT a.file_name,a.sha256,a.content_purged_at FROM inbound_attachments a JOIN inbound_messages i ON i.id=a.inbound_message_id
        WHERE a.id=$1 AND i.id=$2 AND ($3::text IS NULL OR i.service_id=$3) AND i.status='ready' AND i.content_purged_at IS NULL`,[id,parentId,serviceId ?? null]);
    const file=found.rows[0];
    if(!file) return null;
    const locked=await lockAttachment(client,id,kind,true);
    const safety=(await client.query<SafetyRow>("SELECT * FROM attachment_safety WHERE resource_id=$1 FOR SHARE",[id])).rows[0];
    const usage=attachmentUsage(Boolean(locked && !locked.content_purged_at),locked?.sha256 ?? null,safety,kind);
    if(!usage.canDownload) throw new AttachmentUseError(usage.processing ? "FILE_NOT_READY" : "FILE_UNAVAILABLE",usage.reasonCode!);
    let bytes:Uint8Array;
    try {bytes=await objectStore().get(locked.object_key,MAX_FILE_BYTES);}catch {throw new ByteAccessError(id,kind,"FILE_STORAGE_UNAVAILABLE");}
    if(bytes.byteLength!==Number(locked.size_bytes) || digest(bytes)!==locked.sha256) throw new ByteAccessError(id,kind,"FILE_INTEGRITY_FAILED");
    const current=attachmentUsage(true,locked.sha256,safety,kind);
    if(!current.canDownload) throw new AttachmentUseError(current.processing ? "FILE_NOT_READY" : "FILE_UNAVAILABLE",current.reasonCode!);
    const name=file.file_name.replace(/[\\"\r\n\x00-\x1f]/g,"_");
    return new Response(Buffer.from(bytes),{headers:{"content-type":"application/octet-stream","content-length":String(bytes.byteLength),
      "content-disposition":`attachment; filename="${name.replace(/[^\x20-\x7e]/g,"_")}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      "x-content-type-options":"nosniff","cache-control":"private, no-store","content-security-policy":"sandbox"}});
  }).catch(rememberFailure);
}
