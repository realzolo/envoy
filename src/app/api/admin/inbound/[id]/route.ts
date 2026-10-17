import { getAdminSession } from "@/server/admin-auth";
import { query } from "@/server/database";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await getAdminSession()) return Response.json({error:"Unauthorized"},{status:401});
  const {id} = await context.params;
  const message = (await query(`SELECT i.id,i.message_id,i.envelope_recipients,i.reply_to,i.in_reply_to,i.references_ids,i.bcc_emails,i.from_email,i.to_emails,i.cc_emails,i.subject,i.sanitized_html,i.text_body,i.status,i.rejection_reason,i.created_at AS received_at,i.author_date,i.ingress_received_at,i.ready_at,i.content_purged_at,
    p.name AS product,s.name AS service,r.local_part_pattern AS route,sd.domain
    FROM inbound_messages i LEFT JOIN products p ON p.id=i.product_id LEFT JOIN services s ON s.id=i.service_id
    LEFT JOIN inbound_routes r ON r.id=i.inbound_route_id LEFT JOIN sending_domains sd ON sd.id=r.sending_domain_id WHERE i.id=$1`,[id])).rows[0];
  if (!message) return Response.json({error:"Inbound message not found"},{status:404});
  const attachments = (await query(`SELECT id,file_name,content_type,size_bytes,content_id,scan_status,content_purged_at FROM inbound_attachments WHERE inbound_message_id=$1 ORDER BY created_at,id`,[id])).rows;
  return Response.json({...message,attachments:attachments.map(file=>({...file,downloadable:message.status==="ready" && !file.content_purged_at && (file.scan_status==="clean" || (file.scan_status==="skipped" && !process.env.CLAMAV_HOST))}))},{headers:{"cache-control":"no-store"}})
}
