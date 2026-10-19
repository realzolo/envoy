import type { PoolClient } from "pg";
import type { InboundRepository } from "../application/ports";
import type { InboundDispatch } from "../contracts";
import { pool, transactionContext } from "@/platform/database";
import { inboundDomainAccess } from "@/modules/identity/infrastructure/authorization";
import { registerAttachment } from "@/modules/attachments/public";
import { completeObjectUploads } from "@/platform/storage/object-cleanup/public";

export function inboundRepository(client: Pick<PoolClient, "query"> = pool()): InboundRepository {
return {
    findDispatches(input: { endpointId: string; recipients: string[]; accountId: string }) { return client.query<InboundDispatch>(`
    SELECT b.service_id,array_agg(DISTINCT recipient ORDER BY recipient) AS recipients
    FROM provider_webhook_endpoints e
    JOIN provider_accounts a ON a.id=e.provider_account_id AND a.status='active'
    CROSS JOIN unnest($2::text[]) recipient
    JOIN sending_domains d ON d.domain=split_part(recipient,'@',2) AND d.status='active'
    JOIN service_domain_bindings b ON b.sending_domain_id=d.id AND b.receive_enabled
    JOIN services s ON s.id=b.service_id AND s.status='active'
    WHERE e.id=$1 AND e.provider_account_id=$3 AND e.status='active' AND e.security_configured
    GROUP BY b.service_id ORDER BY b.service_id`, [input.endpointId, input.recipients, input.accountId]); },
    freezeReceipt(input: { accountId: string; externalId: string; routesJson: string; rawEventId: string }) { return client.query<Record<string, unknown>>(`INSERT INTO inbound_receipts(provider_account_id,external_message_id,routes,ingress_received_at)
      VALUES($1,$2,$3,COALESCE((SELECT received_at FROM raw_provider_events WHERE id=$4),clock_timestamp()))
      ON CONFLICT DO NOTHING`, [input.accountId, input.externalId, input.routesJson, input.rawEventId]); },
    readReceipt(input: { accountId: string; externalId: string }) { return client.query<{ routes: InboundDispatch[]; terminated_at:Date | null; ingress_received_at: Date }>("SELECT routes,terminated_at,ingress_received_at FROM inbound_receipts WHERE provider_account_id=$1 AND external_message_id=$2", [input.accountId, input.externalId]); },
    findTombstone(input: { accountId: string; externalId: string }) { return client.query<{id:string}>("SELECT id FROM inbound_messages WHERE provider_account_id=$1 AND external_message_id=$2 ORDER BY created_at,id LIMIT 1", [input.accountId, input.externalId]); },
    insertRejected(input: { id: string; accountId: string; rawEventId: string; externalId: string; messageId: string | null; from: string; to: string[]; cc: string[]; bcc: string[]; subject: string; html: string | null; text: string | null; reason: "NO_RECEIVING_SERVICE" | "ENVELOPE_RECIPIENT_UNAVAILABLE"; receivedAt: Date | undefined; envelope: string[]; replyTo: string[]; inReplyTo: string | null; references: string[]; authorDate: string | null }) { return client.query<{ id: string }>(`INSERT INTO inbound_messages
      (id,provider_account_id,raw_provider_event_id,external_message_id,message_id,from_email,to_emails,cc_emails,bcc_emails,subject,sanitized_html,text_body,status,rejection_reason,received_at,envelope_recipients,reply_to,in_reply_to,references_ids,ingress_received_at,author_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'rejected',$13,$14,$15,$16,$17,$18,$14,$19)
      ON CONFLICT(provider_account_id,external_message_id,delivery_scope) DO UPDATE SET external_message_id=EXCLUDED.external_message_id RETURNING id`, [input.id, input.accountId, input.rawEventId, input.externalId, input.messageId, input.from, input.to, input.cc, input.bcc, input.subject, input.html, input.text, input.reason, input.receivedAt, input.envelope, input.replyTo, input.inReplyTo, input.references, input.authorDate]); },
    allowedDomains(input: { serviceId: string }) { return client.query<{domain:string}>(`SELECT d.domain FROM sending_domains d JOIN service_domain_bindings b ON b.sending_domain_id=d.id AND b.service_id=$1 AND b.receive_enabled JOIN services s ON s.id=b.service_id AND s.status='active' WHERE d.status='active'`, [input.serviceId]); },
    findCopy(input: { accountId: string; externalId: string; scope: string }) { return client.query<{ id: string; status: string; content_purged_at: Date | null }>("SELECT id,status,content_purged_at FROM inbound_messages WHERE provider_account_id=$1 AND external_message_id=$2 AND delivery_scope=$3", [input.accountId, input.externalId, input.scope]); },
    insertCopy(input: { id: string; serviceId: string | null; accountId: string; rawEventId: string; externalId: string; messageId: string | null; from: string; to: string[]; cc: string[]; bcc: string[]; subject: string; html: string | null; text: string | null; receivedAt: Date | undefined; scope: string; envelope: string[]; replyTo: string[]; inReplyTo: string | null; references: string[] }) { return client.query<Record<string, unknown>>(`INSERT INTO inbound_messages(id, service_id,
                                                             provider_account_id, raw_provider_event_id,
                                                             external_message_id, message_id, from_email, to_emails,
                                                             cc_emails, bcc_emails, subject, sanitized_html, text_body,
                                                             status, received_at, delivery_scope, envelope_recipients, reply_to, in_reply_to, references_ids)
                                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'scanning',
                                        $14,$15,$16,$17,$18,$19) ON CONFLICT(provider_account_id,external_message_id,delivery_scope) DO NOTHING RETURNING id`, [input.id, input.serviceId, input.accountId, input.rawEventId, input.externalId, input.messageId, input.from, input.to, input.cc, input.bcc, input.subject, input.html, input.text, input.receivedAt, input.scope, input.envelope, input.replyTo, input.inReplyTo, input.references]); },
    findConcurrentCopy(input: { accountId: string; externalId: string; scope: string }) { return client.query<{
      id: string;
      status: string
    }>("SELECT id,status FROM inbound_messages WHERE provider_account_id=$1 AND external_message_id=$2 AND delivery_scope=$3", [input.accountId, input.externalId, input.scope]); },
    recordDates(input: { id: string; ingressReceivedAt: Date | undefined; authorDate: string | null }) { return client.query<Record<string, unknown>>(`UPDATE inbound_messages SET ingress_received_at=$2,author_date=$3 WHERE id=$1 AND ingress_received_at IS NULL AND content_purged_at IS NULL`, [input.id, input.ingressReceivedAt, input.authorDate]); },
    claimCopy(input: { id: string; token: string }) { return client.query<{ received_at: Date }>("UPDATE inbound_messages SET processing_token=$2,processing_deadline_at=now()+interval '2 minutes' WHERE id=$1 AND status='scanning' AND (processing_token IS NULL OR processing_deadline_at<=now()) RETURNING received_at", [input.id, input.token]); },
    copyState(input: { id: string }) { return client.query<{ status: string }>("SELECT status FROM inbound_messages WHERE id=$1", [input.id]); },
    renewClaim(input: { id: string; token: string }) { return client.query<Record<string, unknown>>("UPDATE inbound_messages SET processing_deadline_at=now()+interval '2 minutes' WHERE id=$1 AND processing_token=$2 RETURNING id", [input.id, input.token]); },
    authorizeCompletion(input: { id: string }) { return client.query<Record<string, unknown>>(`SELECT id FROM inbound_messages i WHERE id=$1 AND ${inboundDomainAccess('i')}`, [input.id]); },
    completeCopy(input: { id: string; rawKey: string | null; token: string }) { return client.query<{ id: string; ready_at: Date }>("UPDATE inbound_messages SET raw_mime_object_key=$2,status='ready',ready_at=clock_timestamp(),rejection_reason=NULL,processing_token=NULL,processing_deadline_at=NULL WHERE id=$1 AND processing_token=$3 AND status='scanning' AND content_purged_at IS NULL RETURNING id,ready_at", [input.id, input.rawKey, input.token]); },
    insertAttachment(input: { id: string; messageId: string; fileName: string; contentType: string; sizeBytes: number; objectKey: string; contentId: string | null; digest: string }) { return client.query<Record<string, unknown>>("INSERT INTO inbound_attachments(id,inbound_message_id,file_name,content_type,size_bytes,object_key,content_id,sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [input.id, input.messageId, input.fileName, input.contentType, input.sizeBytes, input.objectKey, input.contentId, input.digest]); },
    subscribedCallbacks(input: { serviceId: string }) { return client.query<{ id: string }>("SELECT id FROM callback_endpoints WHERE service_id=$1 AND status='active' AND 'inbound.received'=ANY(subscribed_events)", [input.serviceId]); },
    insertCallback(input: { id: string; endpointId: string; messageId: string; payload: Record<string, unknown> }) { return client.query<Record<string, unknown>>("INSERT INTO callback_deliveries(id,endpoint_id,inbound_message_id,event_type,payload) VALUES ($1,$2,$3,'inbound.received',$4)", [input.id, input.endpointId, input.messageId, input.payload]); },
    enqueueCallback(input: { outboxId: string; id: string; payload: Record<string, unknown> }) { return client.query<Record<string, unknown>>("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'callback',$2,'callback.requested',$3)", [input.outboxId, input.id, input.payload]); },
    rejectCopy(input: { id: string; reason: string; token: string }) { return client.query<Record<string, unknown>>("UPDATE inbound_messages SET status='rejected',rejection_reason=$2,processing_token=NULL,processing_deadline_at=NULL WHERE id=$1 AND processing_token=$3", [input.id, input.reason, input.token]); },
    releaseClaim(input: { id: string; token: string }) { return client.query<Record<string, unknown>>("UPDATE inbound_messages SET processing_token=NULL,processing_deadline_at=NULL WHERE id=$1 AND processing_token=$2", [input.id, input.token]); },
  registerAttachment: (id, kind, serviceId, digest) => registerAttachment(transactionContext(client as PoolClient), id, kind, serviceId, digest),
  completeUploads: keys => completeObjectUploads(transactionContext(client as PoolClient), keys),
};
}
