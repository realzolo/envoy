import { inboundDomainAccess } from "@/modules/identity/infrastructure/authorization";
import { downloadAttachment } from "@/modules/attachments/public";
import { attachmentUsage, type SafetyRow } from "@/modules/attachments/public";
import { query } from "@/platform/database";
import { encodeCursor } from "@/lib/pagination";

type Cursor = { at: Date | string; id: string } | null | undefined;

function nextCursor<T extends { id: string; cursor_at?: string }>(rows: T[], limit: number, date: (row: T) => Date) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    nextCursor: hasMore ? encodeCursor({
      id: data[data.length - 1].id,
      cursor_at: data[data.length - 1].cursor_at,
      accepted_at: date(data[data.length - 1])
    }) : null,
  };
}

export async function listInboundMessages(serviceId: string, options: { limit: number; cursor?: Cursor }) {
  const rows = (await query<{
    id: string;
    from_email: string;
    to_emails: string[];
    subject: string;
    status: string;
    received_at: Date;
    author_date: Date | null; ingress_received_at: Date | null; ready_at: Date | null;
    attachment_count: string;
  }>(
    `SELECT i.id,i.from_email,i.to_emails,i.subject,i.status,i.created_at AS received_at,i.author_date,i.ingress_received_at,i.ready_at,to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,count(a.id)::text AS attachment_count
     FROM inbound_messages i LEFT JOIN inbound_attachments a ON a.inbound_message_id=i.id
     WHERE i.service_id=$1 AND ${inboundDomainAccess('i')} AND ($2::timestamptz IS NULL OR (i.created_at,i.id)<($2,$3))
     GROUP BY i.id ORDER BY i.created_at DESC,i.id DESC LIMIT $4`,
    [serviceId, options.cursor?.at ?? null, options.cursor?.id ?? null, options.limit + 1],
  )).rows;
  const page = nextCursor(rows, options.limit, row => row.received_at);
  return {
    data: page.data.map(row => ({
      id: row.id,
      from: row.from_email,
      to: row.to_emails,
      subject: row.subject,
      status: row.status,
      attachmentCount: Number(row.attachment_count),
      receivedAt: row.received_at.toISOString(),
      authorDate: row.author_date?.toISOString() ?? null,
      ingressReceivedAt: row.ingress_received_at?.toISOString() ?? null,
      readyAt: row.ready_at?.toISOString() ?? null,
    })),
    nextCursor: page.nextCursor,
  };
}

export async function getInboundMessage(id: string, serviceId: string) {
  const message = (await query<{
    id: string;
    external_message_id: string | null;
    message_id: string | null;
    envelope_recipients: string[]; reply_to: string[]; in_reply_to: string | null; references_ids: string[];
    from_email: string;
    to_emails: string[];
    cc_emails: string[];
    bcc_emails: string[];
    subject: string;
    sanitized_html: string | null;
    text_body: string | null;
    content_purged_at: Date | null;
    status: string;
    rejection_reason: string | null;
    received_at: Date;
    author_date: Date | null; ingress_received_at: Date | null; ready_at: Date | null;
  }>(`SELECT id,external_message_id,message_id,envelope_recipients,reply_to,in_reply_to,references_ids,from_email,to_emails,cc_emails,bcc_emails,subject,sanitized_html,text_body,content_purged_at,status,rejection_reason,created_at AS received_at,author_date,ingress_received_at,ready_at FROM inbound_messages i WHERE id=$1 AND service_id=$2 AND ${inboundDomainAccess('i')}`, [id, serviceId])).rows[0];
  if (!message) return null;
  const attachments = (await query<{
    id: string;
    file_name: string;
    content_type: string;
    size_bytes: string;
    content_id: string | null;
    sha256: string; safety: SafetyRow | null;
    content_purged_at: Date | null;
  }>("SELECT a.id,a.file_name,a.content_type,a.size_bytes::text,a.content_id,a.sha256,a.content_purged_at,row_to_json(s) AS safety FROM inbound_attachments a LEFT JOIN attachment_safety s ON s.resource_id=a.id WHERE a.inbound_message_id=$1 ORDER BY a.created_at,a.id", [id])).rows;
  return {
    id: message.id,
    messageId: message.message_id ?? null,
    envelopeRecipients: message.envelope_recipients ?? [],
    replyTo: message.reply_to ?? [],
    inReplyTo: message.in_reply_to ?? null,
    references: message.references_ids ?? [],
    from: message.from_email,
    to: message.to_emails,
    cc: message.cc_emails,
    bcc: message.bcc_emails,
    subject: message.subject,
    html: message.sanitized_html,
    text: message.text_body,
    contentPurgedAt: message.content_purged_at?.toISOString() ?? null,
    status: message.status,
    rejectionReason: message.rejection_reason,
    receivedAt: message.received_at.toISOString(),
    authorDate: message.author_date?.toISOString() ?? null,
    ingressReceivedAt: message.ingress_received_at?.toISOString() ?? null,
    readyAt: message.ready_at?.toISOString() ?? null,
    attachments: attachments.map(item => ({
      id: item.id,
      fileName: item.file_name,
      contentType: item.content_type,
      size: Number(item.size_bytes),
      contentId: item.content_id,
      usage: attachmentUsage(item.content_purged_at === null,item.sha256,item.safety,"inbound"),
      contentAvailable: item.content_purged_at === null,
    })),
  };
}

// serviceId is mandatory for service callers; administrators call without it
// only after their own session authorization. Object keys never leave the server.
export async function getInboundAttachment(id: string, attachmentId: string, serviceId?: string) {
  return downloadAttachment("inbound",attachmentId,serviceId,id);
}

export async function ownsInboundAttachment(id: string, attachmentId: string, serviceId: string) {
  return !!(await query("SELECT a.id FROM inbound_attachments a JOIN inbound_messages i ON i.id=a.inbound_message_id WHERE i.id=$1 AND a.id=$2 AND i.service_id=$3", [id, attachmentId, serviceId])).rowCount;
}
