import { attachmentUsage } from "@/modules/attachments/safety";
import { getAdminSession } from "@/server/admin-auth";
import { query } from "@/server/database";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return Response.json({error:"Unauthorized"},{status:401});
  const {id} = await context.params;
  const message = (await query(`SELECT i.id,i.message_id,i.envelope_recipients,i.reply_to,i.in_reply_to,i.references_ids,i.bcc_emails,i.from_email,i.to_emails,i.cc_emails,i.subject,i.sanitized_html,i.text_body,i.status,i.rejection_reason,i.created_at AS received_at,i.author_date,i.ingress_received_at,i.ready_at,i.content_purged_at,
    p.name AS product,s.name AS service,sd.domain AS route,sd.domain
    FROM inbound_messages i LEFT JOIN products p ON p.id=i.product_id LEFT JOIN services s ON s.id=i.service_id
    LEFT JOIN inbound_routes r ON r.id=i.inbound_route_id LEFT JOIN sending_domains sd ON sd.id=r.sending_domain_id WHERE i.id=$1`,[id])).rows[0];
  if (!message) return Response.json({error:"Inbound message not found"},{status:404});
  const attachments = (await query(`SELECT a.id,a.file_name,a.content_type,a.size_bytes,a.content_id,a.sha256,a.content_purged_at,row_to_json(s) AS safety FROM inbound_attachments a LEFT JOIN attachment_safety s ON s.resource_id=a.id WHERE a.inbound_message_id=$1 ORDER BY a.created_at,a.id`,[id])).rows;
  return Response.json({...message,attachments:attachments.map(file=>({...file,usage:attachmentUsage(!file.content_purged_at,file.sha256,file.safety,"inbound"),downloadable:message.status==="ready" && attachmentUsage(!file.content_purged_at,file.sha256,file.safety,"inbound").canDownload}))},{headers:{"cache-control":"no-store"}})
}
