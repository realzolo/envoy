import { query } from "@/platform/database";
import { fetchDocumentImage } from "@/platform/mail-media";
import { outboundDomainAccess } from "@/modules/identity/infrastructure/authorization";
import { digest, readAttachment, scanBytes, scanPolicy } from "@/modules/attachments/public";
import { createOutboundPreviewService, type PreviewRecord } from "../application/preview";

export const { getPreview: getOutboundPreview, readResource: readOutboundPreviewResource } = createOutboundPreviewService({
  async read(deliveryId) {
    const row = (await query<{id:string;service_id:string;html_body:string;attachment_snapshot:PreviewRecord["attachments"]}>(`
      SELECT m.id,m.service_id,m.html_body,m.attachment_snapshot FROM messages m
      JOIN deliveries d ON d.message_id=m.id
      WHERE d.id=$1 AND m.content_policy='normal' AND m.content_purged_at IS NULL
        AND m.html_body IS NOT NULL AND ${outboundDomainAccess("m")}`, [deliveryId])).rows[0];
    return row ? { messageId: row.id, serviceId: row.service_id, html: row.html_body,
      attachments: row.attachment_snapshot.map(file => ({fileId:file.fileId,contentId:file.contentId,disposition:file.disposition,size:file.size,sha256:file.sha256})),
    } : null;
  },
  digest, scanPolicy, scan: scanBytes, fetchImage: fetchDocumentImage,
  readAttachment: (fileId, serviceId) => readAttachment("outbound", fileId, serviceId),
});
