import { query } from "@/platform/database";
import { outboundDomainAccess } from "@/modules/identity/infrastructure/authorization";
import type { ReaderSource } from "@/modules/mail-reader/contracts";
import type { StoredAttachment } from "../contracts";
export async function readOutboundReaderSource(id:string,serviceId:string|null):Promise<ReaderSource|null> {
  const row=(await query<{id:string;service_id:string;html_body:string|null;text_body:string|null;attachment_snapshot:StoredAttachment[]}>(`SELECT m.id,m.service_id,m.html_body,m.text_body,m.attachment_snapshot FROM messages m JOIN deliveries d ON d.message_id=m.id
    WHERE d.id=$1 AND m.content_policy='normal' AND m.content_purged_at IS NULL AND ($2::text IS NULL OR m.service_id=$2) AND ${outboundDomainAccess("m")}`,[id,serviceId])).rows[0];
  return row?{kind:"OUTBOUND",id,serviceId:row.service_id,html:row.html_body,text:row.text_body,attachments:row.attachment_snapshot.map(file=>({id:file.fileId,contentId:file.contentId,contentType:file.contentType,size:file.size,sha256:file.sha256}))}:null;
}

export async function resolveOutboundReaderDelivery(messageId:string,recipient:string,serviceId:string) {
 const rows=(await query<{id:string}>(`SELECT d.id FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.id=$1 AND d.recipient_email=$2 AND m.service_id=$3 AND m.content_policy='normal' AND m.content_purged_at IS NULL AND ${outboundDomainAccess("m")}`,[messageId,recipient,serviceId])).rows;
 return rows.length===1?rows[0].id:null;
}
