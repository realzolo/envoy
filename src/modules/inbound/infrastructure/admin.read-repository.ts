import {query} from '@/platform/database';
import type {RawEventDto,InboundMessageDto,InboundRouteDto} from '@/modules/admin/contracts';
export const inboundAdminReads={rawEvents: () => query<RawEventDto>(`SELECT r.id,r.native_type,r.provider_event_id,r.signature_valid,r.replay_valid,r.received_at,r.processed_at,r.processing_error,r.processing_attempt_count,r.terminated_at,r.content_purged_at,r.raw_payload_purged_at,pa.name AS account,pa.type
    FROM raw_provider_events r JOIN provider_accounts pa ON pa.id=r.provider_account_id ORDER BY r.received_at DESC LIMIT 200`),
inbound: () => query<InboundMessageDto>(`SELECT i.id,i.service_id,i.content_purged_at,i.from_email,i.to_emails,i.subject,i.status,i.created_at AS received_at,i.author_date,i.ingress_received_at,i.ready_at,p.name AS product,count(a.id) AS attachment_count
    FROM inbound_messages i
    LEFT JOIN products p ON p.id=i.product_id
    LEFT JOIN inbound_attachments a ON a.inbound_message_id=i.id
    GROUP BY i.id,p.name ORDER BY i.created_at DESC LIMIT 200`),
inboundRoutes: () => query<InboundRouteDto>(`SELECT r.id,r.status,sd.domain,p.name AS product,s.name AS service,e.opaque_token,pa.type AS provider_type,ce.name AS callback,
      CASE WHEN ce.id IS NULL THEN 'Polling only'
        WHEN ce.service_id IS DISTINCT FROM r.service_id THEN 'CALLBACK_BINDING_INVALID'
        WHEN ce.status<>'active' THEN 'CALLBACK_DISABLED'
        WHEN NOT('inbound.received'=ANY(ce.subscribed_events)) THEN 'CALLBACK_EVENT_NOT_SUBSCRIBED'
        ELSE 'Callback and polling configured' END AS notification_state
    FROM inbound_routes r
    JOIN sending_domains sd ON sd.id=r.sending_domain_id
    JOIN products p ON p.id=r.product_id
    LEFT JOIN services s ON s.id=r.service_id
    JOIN provider_webhook_endpoints e ON e.id=r.provider_webhook_endpoint_id
    JOIN provider_accounts pa ON pa.id=e.provider_account_id
    LEFT JOIN callback_endpoints ce ON ce.service_id=r.service_id AND ce.url IS NOT NULL
    ORDER BY r.created_at DESC`)};

import type {SafetyRow} from '@/modules/attachments/contracts';
type InboundDetailRow={id:string;message_id:string;envelope_recipients:string[];reply_to:string[];in_reply_to:string|null;references_ids:string[];bcc_emails:string[];from_email:string;to_emails:string[];cc_emails:string[];subject:string;sanitized_html:string|null;text_body:string|null;status:string;rejection_reason:string|null;received_at:Date;author_date:Date|null;ingress_received_at:Date;ready_at:Date|null;content_purged_at:Date|null;product:string|null;service:string|null;route:string|null;domain:string|null};
type InboundAttachmentRow={id:string;file_name:string;content_type:string;size_bytes:string;content_id:string|null;sha256:string;content_purged_at:Date|null;safety:SafetyRow|null};
export async function readAdminInboundDetail(id:string){
  const message = (await query<InboundDetailRow>(`SELECT i.id,i.message_id,i.envelope_recipients,i.reply_to,i.in_reply_to,i.references_ids,i.bcc_emails,i.from_email,i.to_emails,i.cc_emails,i.subject,i.sanitized_html,i.text_body,i.status,i.rejection_reason,i.created_at AS received_at,i.author_date,i.ingress_received_at,i.ready_at,i.content_purged_at,
    p.name AS product,s.name AS service,sd.domain AS route,sd.domain
    FROM inbound_messages i LEFT JOIN products p ON p.id=i.product_id LEFT JOIN services s ON s.id=i.service_id
    LEFT JOIN inbound_routes r ON r.id=i.inbound_route_id LEFT JOIN sending_domains sd ON sd.id=r.sending_domain_id WHERE i.id=$1`,[id])).rows[0];

  if(!message)return null;
  const attachments = (await query<InboundAttachmentRow>(`SELECT a.id,a.file_name,a.content_type,a.size_bytes,a.content_id,a.sha256,a.content_purged_at,row_to_json(s) AS safety FROM inbound_attachments a LEFT JOIN attachment_safety s ON s.resource_id=a.id WHERE a.inbound_message_id=$1 ORDER BY a.created_at,a.id`,[id])).rows;
  return {message,attachments};
}
