import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "@/server/database";
import { objectStore } from "@/modules/config/object-store";
import { completeObjectUploads, registerObjectUpload } from "@/server/services/object-cleanup";
import { createId } from "@/server/ids";
import { MAX_ATTACHMENT_BYTES, MAX_FILE_BYTES, type CreateMessageInput } from "@/lib/contracts";

export type AttachmentSnapshot = { fileId: string; fileName: string; contentType: string; size: number; sha256: string; objectKey: string; disposition: "attachment" | "inline"; contentId: string | null };
type FileRow = { id: string; service_id: string; file_name: string; content_type: string; size_bytes: string; sha256: string; object_key: string; content_purged_at: Date | null; created_at: Date };

export class FileValidationError extends Error {}

export async function uploadOutboundFile(serviceId: string, fileName: string, contentType: string, bytes: Uint8Array) {
  if (!bytes.byteLength || bytes.byteLength > MAX_FILE_BYTES) throw new FileValidationError(`File must contain between 1 and ${MAX_FILE_BYTES} bytes.`);
  if (!fileName || fileName.length > 255 || /[\\/\r\n\x00-\x1f\x7f]/.test(fileName)) throw new FileValidationError("X-File-Name must be a plain file name of at most 255 characters.");
  if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(contentType)) throw new FileValidationError("Content-Type must contain a media type without parameters.");
  const id = createId("file");
  const key = `outbound/${serviceId}/${id}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await registerObjectUpload(key);
  await objectStore().put(key, bytes, contentType);
  // The cleanup claim and file reference commit together. An uncertain commit must
  // never trigger unconditional deletion of bytes referenced by a committed file.
  await transaction(async client => {
    await completeObjectUploads(client, [key]);
    await client.query(`INSERT INTO outbound_files(id,service_id,file_name,content_type,size_bytes,sha256,object_key) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id,serviceId,fileName,contentType,bytes.byteLength,sha256,key]);
  });
  return (await getOutboundFile(id, serviceId))!;
}

export async function getOutboundFile(id: string, serviceId: string) {
  const row = (await query<FileRow>("SELECT * FROM outbound_files WHERE id=$1 AND service_id=$2", [id,serviceId])).rows[0];
  if (!row) return null;
  return { id: row.id, fileName: row.file_name, contentType: row.content_type, size: Number(row.size_bytes), sha256: row.sha256, contentAvailable: row.content_purged_at === null, createdAt: row.created_at.toISOString() };
}

export async function resolveOutboundAttachments(serviceId: string, attachments: CreateMessageInput["attachments"], client?: PoolClient): Promise<AttachmentSnapshot[]> {
  if (!attachments.length) return [];
  const parameters = [attachments.map(item => item.fileId), serviceId];
  // Row locks prevent retention from purging an attachment while its immutable
  // message reference is being committed by the acceptance transaction.
  const sql = `SELECT * FROM outbound_files WHERE id=ANY($1::text[]) AND service_id=$2 AND content_purged_at IS NULL${client ? " FOR SHARE" : ""}`;
  const rows = client ? (await client.query<FileRow>(sql, parameters)).rows : (await query<FileRow>(sql, parameters)).rows;
  const byId = new Map(rows.map(row => [row.id,row]));
  let total = 0;
  const snapshot = attachments.map(item => {
    const file = byId.get(item.fileId);
    if (!file) throw new FileValidationError(`Attachment ${item.fileId} is unavailable or is not owned by this service.`);
    total += Number(file.size_bytes);
    return { fileId: file.id, fileName: item.fileName ?? file.file_name, contentType: file.content_type, size: Number(file.size_bytes), sha256: file.sha256, objectKey: file.object_key, disposition: item.disposition, contentId: item.contentId ?? null };
  });
  if (total > MAX_ATTACHMENT_BYTES) throw new FileValidationError(`Attachments must total at most ${MAX_ATTACHMENT_BYTES} bytes.`);
  return snapshot;
}
