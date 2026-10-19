import { createHash } from "node:crypto";
import { AttachmentUseError } from "../domain/safety";
import { createId } from "@/platform/ids";
import { MAX_ATTACHMENT_BYTES, MAX_FILE_BYTES, type CreateMessageInput } from "@/lib/contracts";
import type { AttachmentDependencies, AttachmentRepositories } from "./ports";
import type { AttachmentSnapshot } from "../contracts";
import { FileValidationError } from "../contracts";

export function createFilesService(dependencies: AttachmentDependencies) {


async function uploadOutboundFile(serviceId: string, fileName: string, contentType: string, bytes: Uint8Array, sendingDomain: string) {
  if (!bytes.byteLength || bytes.byteLength > MAX_FILE_BYTES) throw new FileValidationError(`File must contain between 1 and ${MAX_FILE_BYTES} bytes.`);
  if (!fileName || fileName.length > 255 || /[\\/\r\n\x00-\x1f\x7f]/.test(fileName)) throw new FileValidationError("X-File-Name must be a plain file name of at most 255 characters.");
  if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(contentType)) throw new FileValidationError("Content-Type must contain a media type without parameters.");
  const domainId=await dependencies.authorizedSendingDomain(serviceId,sendingDomain);
  if(!domainId) throw new FileValidationError("The service is not authorized to upload files for this sending domain.");
  const id = createId("file");
  const key = `outbound/${serviceId}/${id}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await dependencies.registerObjectUpload(key);
  await dependencies.objectStore.put(key, bytes, contentType);
  // The cleanup claim and file reference commit together. An uncertain commit must
  // never trigger unconditional deletion of bytes referenced by a committed file.
  await dependencies.unitOfWork.run(async client => {
    if(await client.authorizedSendingDomain(serviceId,sendingDomain)!==domainId) throw new FileValidationError("Domain sending permission was revoked while receiving the file.");
    await client.completeObjectUploads([key]);
    await client.files.insertFile({ id: id, serviceId: serviceId, fileName: fileName, contentType: contentType, byteLength: bytes.byteLength, sha256: sha256, key: key, domainId: domainId });
    await client.registerAttachment(id,"outbound",serviceId,sha256);
  });
  return (await getOutboundFile(id, serviceId))!;
}

async function getOutboundFile(id: string, serviceId: string) {
  const row = (await dependencies.repositories.files.findAuthorizedFile({ id: id, serviceId: serviceId })).rows[0];
  if (!row) return null;
  return { id: row.id, fileName: row.file_name, contentType: row.content_type, size: Number(row.size_bytes), sha256: row.sha256, contentAvailable: row.content_purged_at === null, usage: dependencies.attachmentUsage(row.content_purged_at === null,row.sha256,row.safety), createdAt: row.created_at.toISOString() };
}

async function resolveOutboundAttachments(serviceId: string, attachments: CreateMessageInput["attachments"], client?: AttachmentRepositories, domainId?:string): Promise<AttachmentSnapshot[]> {
  if (!attachments.length) return [];
  
  // Row locks prevent retention from purging an attachment while its immutable
  // message reference is being committed by the acceptance transaction.
  const rows = client ? (await client.files.listLockedFiles({ fileIds: attachments.map(item => item.fileId), serviceId: serviceId })).rows : (await dependencies.repositories.files.listFiles({ fileIds: attachments.map(item => item.fileId), serviceId: serviceId })).rows;
  if (client && rows.length) {
    const safety = (await client.files.listLockedSafety({ resourceIds: rows.map(row=>row.id) })).rows;
    for (const row of rows) row.safety=safety.find(item=>item.resource_id===row.id) ?? null;
  }
  const byId = new Map(rows.map(row => [row.id,row]));
  let total = 0;
  const snapshot = attachments.map(item => {
    const file = byId.get(item.fileId);
    if (file && domainId && file.sending_domain_id!==domainId) throw new AttachmentUseError("FILE_UNAVAILABLE","FILE_DOMAIN_MISMATCH");
    if (!file) throw new AttachmentUseError("FILE_UNAVAILABLE","FILE_NOT_AVAILABLE");
    dependencies.assertUsable(file.content_purged_at === null,file.sha256,file.safety);
    total += Number(file.size_bytes);
    return { fileId: file.id, fileName: item.fileName ?? file.file_name, contentType: file.content_type, size: Number(file.size_bytes), sha256: file.sha256, objectKey: file.object_key, disposition: item.disposition, contentId: item.contentId ?? null };
  });
  if (total > MAX_ATTACHMENT_BYTES) throw new FileValidationError(`Attachments must total at most ${MAX_ATTACHMENT_BYTES} bytes.`);
  return snapshot;
}
return { uploadOutboundFile, getOutboundFile, resolveOutboundAttachments };
}
