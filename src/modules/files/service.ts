import { authorizedSendingDomain,outboundDomainAccess } from "@/modules/core/resources/authorization";
import { createHash } from "node:crypto";
import { AttachmentUseError, registerAttachment, attachmentUsage, assertUsable, type SafetyRow } from "@/modules/attachments/safety";
import type { PoolClient } from "pg";
import { query, transaction } from "@/server/database";
import { objectStore } from "@/modules/config/object-store";
import { completeObjectUploads, registerObjectUpload } from "@/server/services/object-cleanup";
import { createId } from "@/server/ids";
import { MAX_ATTACHMENT_BYTES, MAX_FILE_BYTES, type CreateMessageInput } from "@/lib/contracts";

export type AttachmentSnapshot = { fileId: string; fileName: string; contentType: string; size: number; sha256: string; objectKey: string; disposition: "attachment" | "inline"; contentId: string | null };
type FileRow = { id: string; service_id: string; sending_domain_id:string; file_name: string; content_type: string; size_bytes: string; sha256: string; object_key: string; content_purged_at: Date | null; created_at: Date; safety: SafetyRow | null };

export class FileValidationError extends Error {}

export async function uploadOutboundFile(serviceId: string, fileName: string, contentType: string, bytes: Uint8Array, sendingDomain: string) {
  if (!bytes.byteLength || bytes.byteLength > MAX_FILE_BYTES) throw new FileValidationError(`File must contain between 1 and ${MAX_FILE_BYTES} bytes.`);
  if (!fileName || fileName.length > 255 || /[\\/\r\n\x00-\x1f\x7f]/.test(fileName)) throw new FileValidationError("X-File-Name must be a plain file name of at most 255 characters.");
  if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(contentType)) throw new FileValidationError("Content-Type must contain a media type without parameters.");
  const domainId=await authorizedSendingDomain(serviceId,sendingDomain);
  if(!domainId) throw new FileValidationError("The service is not authorized to upload files for this sending domain.");
  const id = createId("file");
  const key = `outbound/${serviceId}/${id}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await registerObjectUpload(key);
  await objectStore().put(key, bytes, contentType);
  // The cleanup claim and file reference commit together. An uncertain commit must
  // never trigger unconditional deletion of bytes referenced by a committed file.
  await transaction(async client => {
    if(await authorizedSendingDomain(serviceId,sendingDomain,client)!==domainId) throw new FileValidationError("Domain sending permission was revoked while receiving the file.");
    await completeObjectUploads(client, [key]);
    await client.query(`INSERT INTO outbound_files(id,service_id,file_name,content_type,size_bytes,sha256,object_key,sending_domain_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id,serviceId,fileName,contentType,bytes.byteLength,sha256,key,domainId]);
    await registerAttachment(client,id,"outbound",serviceId,sha256);
  });
  return (await getOutboundFile(id, serviceId))!;
}

export async function getOutboundFile(id: string, serviceId: string) {
  const row = (await query<FileRow>(`SELECT f.*,row_to_json(s) AS safety FROM outbound_files f LEFT JOIN attachment_safety s ON s.resource_id=f.id WHERE f.id=$1 AND f.service_id=$2 AND ${outboundDomainAccess('f')}`, [id,serviceId])).rows[0];
  if (!row) return null;
  return { id: row.id, fileName: row.file_name, contentType: row.content_type, size: Number(row.size_bytes), sha256: row.sha256, contentAvailable: row.content_purged_at === null, usage: attachmentUsage(row.content_purged_at === null,row.sha256,row.safety), createdAt: row.created_at.toISOString() };
}

export async function resolveOutboundAttachments(serviceId: string, attachments: CreateMessageInput["attachments"], client?: PoolClient, domainId?:string): Promise<AttachmentSnapshot[]> {
  if (!attachments.length) return [];
  const parameters = [attachments.map(item => item.fileId), serviceId];
  // Row locks prevent retention from purging an attachment while its immutable
  // message reference is being committed by the acceptance transaction.
  const sql = `SELECT f.*, (SELECT row_to_json(s) FROM attachment_safety s WHERE s.resource_id=f.id) AS safety FROM outbound_files f WHERE f.id=ANY($1::text[]) AND f.service_id=$2 AND ${outboundDomainAccess('f')} ORDER BY f.id${client ? " FOR SHARE" : ""}`;
  const rows = client ? (await client.query<FileRow>(sql, parameters)).rows : (await query<FileRow>(sql, parameters)).rows;
  if (client && rows.length) {
    const safety = (await client.query<SafetyRow & {resource_id:string}>("SELECT * FROM attachment_safety WHERE resource_id=ANY($1::text[]) ORDER BY resource_id FOR SHARE",[rows.map(row=>row.id)])).rows;
    for (const row of rows) row.safety=safety.find(item=>item.resource_id===row.id) ?? null;
  }
  const byId = new Map(rows.map(row => [row.id,row]));
  let total = 0;
  const snapshot = attachments.map(item => {
    const file = byId.get(item.fileId);
    if (file && domainId && file.sending_domain_id!==domainId) throw new AttachmentUseError("FILE_UNAVAILABLE","FILE_DOMAIN_MISMATCH");
    if (!file) throw new AttachmentUseError("FILE_UNAVAILABLE","FILE_NOT_AVAILABLE");
    assertUsable(file.content_purged_at === null,file.sha256,file.safety);
    total += Number(file.size_bytes);
    return { fileId: file.id, fileName: item.fileName ?? file.file_name, contentType: file.content_type, size: Number(file.size_bytes), sha256: file.sha256, objectKey: file.object_key, disposition: item.disposition, contentId: item.contentId ?? null };
  });
  if (total > MAX_ATTACHMENT_BYTES) throw new FileValidationError(`Attachments must total at most ${MAX_ATTACHMENT_BYTES} bytes.`);
  return snapshot;
}
