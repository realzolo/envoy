import { assertSendDeadline } from "@/modules/outbound/policy";
import { MAX_FILE_BYTES } from "@/lib/contracts";
import { AttachmentUseError } from "../domain/safety";
import { digest } from "../domain/digest";

import type { AttachmentDependencies } from "./ports";
import type { AttachmentSnapshot } from "../contracts";

export function createAccessService(dependencies: AttachmentDependencies) {
class ByteAccessError extends AttachmentUseError {
  constructor(public id:string,public kind:"outbound"|"inbound",reason:string) {super("FILE_UNAVAILABLE",reason);}
}

async function rememberFailure(error:unknown) {
  if (!(error instanceof ByteAccessError)) throw error;
  await dependencies.unitOfWork.run(async client=>{
    const file=await client.lockAttachment(error.id,error.kind);
    if (!file || file.content_purged_at) return;
    await client.access.rememberByteFailure({ id: error.id, status: error.reasonCode==="FILE_INTEGRITY_FAILED" ? "blocked" : "unavailable", reasonCode: error.reasonCode });
  });
  throw error;
}

async function withSafeOutboundAttachments<T>(messageId:string,attemptId:string,files:AttachmentSnapshot[],send:(bytes:Uint8Array[],beforeSend:()=>Promise<void>)=>Promise<T>) {
  return dependencies.unitOfWork.run(async client => {
    const owner = (await client.access.lockAuthorizedOwner({ messageId: messageId })).rows[0];
    if (!owner || owner.content_purged_at) throw new AttachmentUseError("FILE_UNAVAILABLE","FILE_CONTENT_PURGED");
    const loaded = new Map<string,Uint8Array>();
    for (const file of [...files].sort((a,b)=>a.fileId.localeCompare(b.fileId))) {
      const row = (await client.access.lockOwnedFile({ fileId: file.fileId, service_id: owner.service_id, sending_domain_id: owner.sending_domain_id })).rows[0];
      const safety = (await client.access.lockSafety({ fileId: file.fileId })).rows[0];
      dependencies.assertUsable(Boolean(row && !row.content_purged_at),row?.sha256 ?? null,safety);
      if (row.sha256!==file.sha256 || row.object_key!==file.objectKey || Number(row.size_bytes)!==file.size) throw new ByteAccessError(file.fileId,"outbound","FILE_INTEGRITY_FAILED");
      let bytes:Uint8Array;
      try {bytes=await dependencies.objectStore.get(row.object_key,MAX_FILE_BYTES);}catch {throw new ByteAccessError(file.fileId,"outbound","FILE_STORAGE_UNAVAILABLE");}
      if (digest(bytes)!==file.sha256 || bytes.byteLength!==file.size) throw new ByteAccessError(file.fileId,"outbound","FILE_INTEGRITY_FAILED");
      loaded.set(file.fileId,bytes);
    }
    // Re-evaluate policy after I/O, immediately before entering the provider network boundary.
    for (const file of files) {
      const safety=(await client.access.readSafety({ fileId: file.fileId })).rows[0];
      dependencies.assertUsable(true,file.sha256,safety);
    }
    const beforeSend = async () => {
      assertSendDeadline(owner.send_before);
      // Preparation may have waited on storage. Never start a stale/expired attempt's network operation.
      // The message lock serializes recovery/cancellation; use wall-clock time, not BEGIN's timestamp.
      const live = await client.access.lockLiveAttempt({ attemptId: attemptId, messageId: messageId });
      if (!live.rowCount) throw new Error("Submission preparation lease is no longer valid");
      if(!(await client.access.verifySendingPermission({ messageId: messageId })).rowCount) throw new AttachmentUseError("FILE_UNAVAILABLE","DOMAIN_SEND_NOT_AUTHORIZED");
      assertSendDeadline(owner.send_before);
    };
    await beforeSend();
    return send(files.map(file=>loaded.get(file.fileId)!),beforeSend);
  }).catch(rememberFailure);
}

async function readAttachment(kind:"outbound"|"inbound",id:string,serviceId?:string,parentId?:string) {
  return dependencies.unitOfWork.run(async client => {
    const found = kind === "outbound" ? await client.access.findDownloadableFile({ id: id, serviceId: serviceId })
      : await client.access.findInboundDownload({ id: id, parentId: parentId, serviceId: serviceId ?? null });
    const file=found.rows[0];
    if(!file) return null;
    const locked=await client.lockAttachment(id,kind,true);
    const safety=(await client.access.lockDownloadSafety({ id: id })).rows[0];
    const usage=dependencies.attachmentUsage(Boolean(locked && !locked.content_purged_at),locked?.sha256 ?? null,safety,kind);
    if(!locked || !usage.canDownload) throw new AttachmentUseError(usage.processing ? "FILE_NOT_READY" : "FILE_UNAVAILABLE",usage.reasonCode!);
    let bytes:Uint8Array;
    try {bytes=await dependencies.objectStore.get(locked.object_key,MAX_FILE_BYTES);}catch {throw new ByteAccessError(id,kind,"FILE_STORAGE_UNAVAILABLE");}
    if(bytes.byteLength!==Number(locked.size_bytes) || digest(bytes)!==locked.sha256) throw new ByteAccessError(id,kind,"FILE_INTEGRITY_FAILED");
    const current=dependencies.attachmentUsage(true,locked.sha256,safety,kind);
    if(!current.canDownload) throw new AttachmentUseError(current.processing ? "FILE_NOT_READY" : "FILE_UNAVAILABLE",current.reasonCode!);
    if (serviceId) {
      const authorized = kind === "outbound" ? await client.access.verifyFilePermission({ id: id, serviceId: serviceId })
        : await client.access.verifyInboundPermission({ parentId: parentId, serviceId: serviceId });
      if (!authorized.rowCount) return null;
    }
    return { fileName: file.file_name, bytes };
  }).catch(rememberFailure);
}
return { withSafeOutboundAttachments, readAttachment };
}
