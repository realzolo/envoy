import { digest } from "@/modules/attachments/scanner";
import { registerAttachment } from "@/modules/attachments/safety";
import { MAX_FILE_BYTES } from "@/lib/contracts";
import sanitizeHtml from "sanitize-html";
import type { CanonicalInboundMessage, WebhookVerification } from "@/modules/providers/contracts";
import { objectStore } from "@/modules/config/object-store";
import { createId } from "@/server/ids";
import { completeObjectUploads, registerObjectUpload } from "@/server/services/object-cleanup";
import { query, transaction } from "@/server/database";
import { domainPermission, inboundDomainAccess } from "@/modules/core/resources/authorization";

const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/** Errors caused by the message or routing policy should not consume worker retries. */
export class InboundTerminalError extends Error {
  constructor(message: string, public code = "INBOUND_REJECTED") {
    super(message);
    this.name = "InboundTerminalError";
  }
}


function address(value: string) {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim().toLowerCase()
}

function authorDate(value:Date|null|undefined) {
  // RFC content dates outside PostgreSQL's portable four-digit ISO range stay unknown.
  return value && Number.isFinite(value.getTime()) && value.getUTCFullYear()>=1 && value.getUTCFullYear()<=9999 ? value.toISOString() : null;
}

type InboundInput = {
  providerAccountId: string;
  webhookEndpointId: string;
  rawEventId: string;
  message: CanonicalInboundMessage;
  ingressReceivedAt?: Date;
};
type InboundRoute = {
  id: string; product_id: string; service_id: string;
  recipients: string[];
};

export async function persistInbound(input: InboundInput) {
  // Empty/invalid envelopes are quarantined, never replaced with visible To/Cc or arbitrary headers.
  const supplied = input.message.envelopeRecipients;
  const recipients = supplied?.length && supplied.every(item => /^[^\s<>@,]+@[^\s<>@,]+$/.test(item))
    ? [...new Set(supplied.map(address))] : [];
  const proposed = recipients.length ? await transaction(async client => (await client.query<InboundRoute>(`
    SELECT r.id,r.product_id,r.service_id,array_agg(DISTINCT recipient) AS recipients
    FROM inbound_routes r JOIN sending_domains d ON d.id=r.sending_domain_id
    JOIN products p ON p.id=r.product_id AND p.status='active'
    JOIN provider_webhook_endpoints e ON e.id=r.provider_webhook_endpoint_id
    CROSS JOIN unnest($2::text[]) recipient
    WHERE e.id=$1 AND e.provider_account_id=$3 AND e.status='active' AND e.security_configured
      AND r.status='active' AND d.status='active' AND ${domainPermission("r.service_id", "d.id", "receive")}
      AND split_part(recipient,'@',2)=d.domain
    GROUP BY r.id ORDER BY r.id`, [input.webhookEndpointId, recipients, input.providerAccountId])).rows) : [];
  // Freeze the complete dispatch plan at the first durable processing decision.
  // Concurrent retries read the winner; later route changes never expand historical access.
  const receipt = await transaction(async client => {
    await client.query(`INSERT INTO inbound_receipts(provider_account_id,external_message_id,routes,ingress_received_at)
      VALUES($1,$2,$3,COALESCE((SELECT received_at FROM raw_provider_events WHERE id=$4),clock_timestamp()))
      ON CONFLICT DO NOTHING`,[input.providerAccountId,input.message.externalMessageId,JSON.stringify(proposed),input.rawEventId]);
    return (await client.query<{ routes: InboundRoute[]; terminated_at:Date | null; ingress_received_at: Date }>(
      "SELECT routes,terminated_at,ingress_received_at FROM inbound_receipts WHERE provider_account_id=$1 AND external_message_id=$2",[input.providerAccountId,input.message.externalMessageId])).rows[0];
  });
  if (receipt.terminated_at) throw new InboundTerminalError("INBOUND_RECEIPT_TERMINATED");
  const routes = receipt.routes;
  input = { ...input, ingressReceivedAt: receipt.ingress_received_at };
  if (!routes.length) {
    const tombstone = (await query<{id:string}>("SELECT id FROM inbound_messages WHERE provider_account_id=$1 AND external_message_id=$2 ORDER BY created_at,id LIMIT 1",[input.providerAccountId,input.message.externalMessageId])).rows[0];
    if (tombstone) return tombstone.id;
    const reason = recipients.length ? "NO_INBOUND_ROUTE" : "ENVELOPE_RECIPIENT_UNAVAILABLE";
    const stored = await query<{ id: string }>(`INSERT INTO inbound_messages
      (id,provider_account_id,raw_provider_event_id,external_message_id,message_id,from_email,to_emails,cc_emails,bcc_emails,subject,sanitized_html,text_body,status,rejection_reason,received_at,envelope_recipients,reply_to,in_reply_to,references_ids,ingress_received_at,author_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'rejected',$13,$14,$15,$16,$17,$18,$14,$19)
      ON CONFLICT(provider_account_id,external_message_id,delivery_scope) DO UPDATE SET external_message_id=EXCLUDED.external_message_id RETURNING id`,
      [createId("inb"),input.providerAccountId,input.rawEventId,input.message.externalMessageId,input.message.messageId??null,address(input.message.from),input.message.to,input.message.cc,input.message.bcc,input.message.subject,input.message.html?sanitizeHtml(input.message.html):null,input.message.text??null,reason,input.ingressReceivedAt,recipients,input.message.replyTo??[],input.message.inReplyTo??null,input.message.references??[],authorDate(input.message.authorDate)]);
    return stored.rows[0].id;
  }
  // One private projection per Service, even for overlapping domain routes.
  const groups = new Map<string, InboundRoute[]>();
  for (const route of routes) {
    const scope = route.service_id;
    groups.set(scope, [...(groups.get(scope) ?? []), route]);
  }
  let firstId = "";
  const failures: unknown[] = [];
  for (const [scope, matching] of groups) {
    const ownRecipients = [...new Set(matching.flatMap(route => route.recipients))];
    const message = { ...input.message, envelopeRecipients: ownRecipients,
      bcc: input.message.bcc.filter(item => ownRecipients.includes(address(item))) };
    try {
      const id = await persistRoutedInbound({ ...input, message }, scope, matching);
      firstId ||= id;
    } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures,"Inbound copies require retry");
  return firstId;
}

async function persistRoutedInbound(input: InboundInput, scope: string, routes: InboundRoute[]) {
  const route = routes[0];
  const allowed=(await query<{domain:string}>(`SELECT d.domain FROM sending_domains d WHERE ${domainPermission("$1", "d.id", "receive")}`,[route.service_id])).rows.map(row=>row.domain);
  const envelopeRecipients=input.message.envelopeRecipients?.filter(recipient=>allowed.includes(recipient.split('@')[1]))??[];
  if(!envelopeRecipients.length) throw new InboundTerminalError("Domain receiving permission was revoked","DOMAIN_RECEIVE_NOT_AUTHORIZED");
  const message = {...input.message,envelopeRecipients,bcc:input.message.bcc.filter(item=>envelopeRecipients.includes(address(item)))};
  const duplicate = (await query<{ id: string; status: string; content_purged_at: Date | null }>(
    "SELECT id,status,content_purged_at FROM inbound_messages WHERE provider_account_id=$1 AND external_message_id=$2 AND delivery_scope=$3",
    [input.providerAccountId,message.externalMessageId,scope])).rows[0];
  if (duplicate?.content_purged_at) return duplicate.id;
  if (duplicate && duplicate.status !== "scanning") return duplicate.id;
  let id = duplicate?.id ?? createId("inb");
  const recipients = message.to.map(address);
  const inserted = duplicate ? null : await query(`INSERT INTO inbound_messages(id, inbound_route_id, product_id, service_id,
                                                             provider_account_id, raw_provider_event_id,
                                                             external_message_id, message_id, from_email, to_emails,
                                                             cc_emails, bcc_emails, subject, sanitized_html, text_body,
                                                             status, received_at, delivery_scope, envelope_recipients, reply_to, in_reply_to, references_ids)
                                VALUES ($1, (SELECT id FROM inbound_routes WHERE id=$2), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'scanning',
                                        $16,$17,$18,$19,$20,$21) ON CONFLICT(provider_account_id,external_message_id,delivery_scope) DO NOTHING RETURNING id`, [id, route.id, route.product_id, route.service_id, input.providerAccountId, input.rawEventId, message.externalMessageId, message.messageId ?? null, address(message.from), recipients, message.cc.map(address), message.bcc.map(address), message.subject, message.html ? sanitizeHtml(message.html) : null, message.text ?? null, input.ingressReceivedAt,scope,message.envelopeRecipients,message.replyTo??[],message.inReplyTo??null,message.references??[]]);
  if (inserted && !inserted.rowCount) {
    const existing = (await query<{
      id: string;
      status: string
    }>("SELECT id,status FROM inbound_messages WHERE provider_account_id=$1 AND external_message_id=$2 AND delivery_scope=$3", [input.providerAccountId, message.externalMessageId,scope])).rows[0];
    if (!existing) throw new Error("Inbound message was not persisted");
    if (existing.status !== "scanning") return existing.id;
    id = existing.id;
  }
  await query(`UPDATE inbound_messages SET ingress_received_at=$2,author_date=$3 WHERE id=$1 AND ingress_received_at IS NULL AND content_purged_at IS NULL`,
    [id,input.ingressReceivedAt,authorDate(message.authorDate)]);
  const token = createId("claim");
  const claimed = await query<{ received_at: Date }>("UPDATE inbound_messages SET processing_token=$2,processing_deadline_at=now()+interval '2 minutes' WHERE id=$1 AND status='scanning' AND (processing_token IS NULL OR processing_deadline_at<=now()) RETURNING received_at", [id, token]);
  if (!claimed.rowCount) {
    const current = (await query<{ status: string }>("SELECT status FROM inbound_messages WHERE id=$1", [id])).rows[0];
    if (current?.status !== "scanning") return id;
    throw new Error("Inbound message is being processed by another worker");
  }
  const receivedAt = claimed.rows[0]?.received_at ?? input.ingressReceivedAt!;
  const prefix = `inbound/${id}/${token}`;
  const writtenKeys: string[] = [];
  let rawKey: string | null = null;
  const attachments: Array<(typeof message.attachments)[number] & {
    objectKey: string;
    sha256: string;
  }> = [];
  try {
    const decodedBytes = Buffer.byteLength((message.html ?? "") + (message.text ?? "") + message.subject, "utf8") + message.attachments.reduce((total, file) => total + file.content.byteLength, 0);
    const aggregateBytes = Math.max(message.rawMime?.byteLength ?? 0, decodedBytes);
    if (aggregateBytes > MAX_MESSAGE_BYTES) throw new InboundTerminalError("Inbound message exceeds the size limit", "INBOUND_MESSAGE_TOO_LARGE");
    for (const file of message.attachments) if (file.content.byteLength > MAX_FILE_BYTES) throw new InboundTerminalError(`Attachment exceeds the size limit: ${file.fileName}`, "INBOUND_ATTACHMENT_TOO_LARGE");
    // Store private bytes first. The shared durable safety pipeline controls every attachment download.
    for (const [index, file] of message.attachments.entries()) {
      attachments.push({ ...file, objectKey: `${prefix}/attachments/${index}`, sha256: digest(file.content) });
    }
    if (message.rawMime) {
      rawKey = `${prefix}/raw.eml`;
      writtenKeys.push(rawKey);
      await registerObjectUpload(rawKey);
      await objectStore().put(rawKey, message.rawMime, "message/rfc822");
    }
    for (const file of attachments) {
      const renewed = await query("UPDATE inbound_messages SET processing_deadline_at=now()+interval '2 minutes' WHERE id=$1 AND processing_token=$2 RETURNING id", [id, token]);
      if (!renewed.rowCount) throw new Error("Inbound processing ownership expired");
      writtenKeys.push(file.objectKey);
      await registerObjectUpload(file.objectKey);
      await objectStore().put(file.objectKey, file.content, file.contentType);
    }
    await transaction(async client => {
      if (!(await client.query(`SELECT id FROM inbound_messages i WHERE id=$1 AND ${inboundDomainAccess('i')}`, [id])).rowCount) {
        throw new InboundTerminalError("Domain receiving permission was revoked", "DOMAIN_RECEIVE_NOT_AUTHORIZED");
      }
      const completed = await client.query("UPDATE inbound_messages SET raw_mime_object_key=$2,status='ready',ready_at=clock_timestamp(),rejection_reason=NULL,processing_token=NULL,processing_deadline_at=NULL WHERE id=$1 AND processing_token=$3 AND status='scanning' AND content_purged_at IS NULL RETURNING id,ready_at", [id, rawKey, token]);
      if (!completed.rowCount) throw new Error("Inbound processing ownership expired");
      for (const file of attachments) {
        const attachmentId=createId("ina");
        await client.query("INSERT INTO inbound_attachments(id,inbound_message_id,file_name,content_type,size_bytes,object_key,content_id,sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [attachmentId, id, file.fileName, file.contentType, file.content.byteLength, file.objectKey, file.contentId ?? null,file.sha256]);
        await registerAttachment(client,attachmentId,"inbound",route.service_id,file.sha256);
      }
      await completeObjectUploads(client, writtenKeys);
      const callback = await client.query<{ id: string }>("SELECT id FROM callback_endpoints WHERE service_id=$1 AND status='active' AND 'inbound.received'=ANY(subscribed_events)", [route.service_id]);
      for (const {id:callbackEndpointId} of callback.rows) {
        const callbackId = createId("cbx");
        const payload = {
          id: `inbound:${id}:received`,
          apiVersion: "2026-09-01",
          type: "inbound.received",
          occurredAt: completed.rows[0].ready_at.toISOString(),
          data: {
            inboundMessageId: id,
            authorDate: authorDate(message.authorDate),
            ingressReceivedAt: receivedAt.toISOString(),
            readyAt: completed.rows[0].ready_at.toISOString(),
            productId: route.product_id,
            serviceId: route.service_id,
            envelopeRecipients: message.envelopeRecipients,
            messageId: message.messageId ?? null,
            replyTo: message.replyTo ?? [],
            inReplyTo: message.inReplyTo ?? null,
            references: message.references ?? [],
            from: address(message.from),
            to: recipients,
            cc: message.cc.map(address),
            subject: message.subject,
            attachments: attachments.map(file => ({
              fileName: file.fileName,
              contentType: file.contentType,
              size: file.content.byteLength
            }))
          }
        };
        await client.query("INSERT INTO callback_deliveries(id,endpoint_id,inbound_message_id,event_type,payload) VALUES ($1,$2,$3,'inbound.received',$4)", [callbackId, callbackEndpointId, id, payload]);
        await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'callback',$2,'callback.requested',$3)", [createId("out"), callbackId, { callbackDeliveryId: callbackId }])
      }
    })
  } catch (error) {
    // COMMIT itself may have lost its response: reference-aware cleanup must decide what is orphaned.
    await Promise.allSettled(writtenKeys.map(key => registerObjectUpload(key)));
    if (error instanceof InboundTerminalError) {
      await query("UPDATE inbound_messages SET status='rejected',rejection_reason=$2,processing_token=NULL,processing_deadline_at=NULL WHERE id=$1 AND processing_token=$3", [id, error.code, token]);
      return id;
    }
    await query("UPDATE inbound_messages SET processing_token=NULL,processing_deadline_at=NULL WHERE id=$1 AND processing_token=$2", [id, token]);
    throw error;
  }
  return id;
}

export async function processInboundEvent(input: {
  providerAccountId: string;
  webhookEndpointId: string;
  rawEventId: string;
  verified: WebhookVerification;
  receive: (verified: WebhookVerification) => Promise<CanonicalInboundMessage | null>
}) {
  if (!input.verified.valid || !input.verified.replaySafe) throw new InboundTerminalError("Unverified inbound event");
  const message = await input.receive(input.verified);
  if (!message) return null;
  return persistInbound({ ...input, message })
}
