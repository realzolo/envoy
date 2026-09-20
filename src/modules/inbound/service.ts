import { createConnection } from "node:net";
import sanitizeHtml from "sanitize-html";
import type { CanonicalInboundMessage, WebhookVerification } from "@/modules/providers/contracts";
import { objectStore } from "@/modules/config/object-store";
import { createId } from "@/server/ids";
import { query, transaction } from "@/server/database";

const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

async function scan(data: Uint8Array) {
  const host = process.env.CLAMAV_HOST;
  if (!host) {
    if (process.env.NODE_ENV === "production") throw new Error("CLAMAV_HOST is required in production");
    return "clean" as const
  }
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  return new Promise<"clean" | "infected">((resolve, reject) => {
    const socket = createConnection({ host, port });
    const chunks: Buffer[] = [];
    socket.setTimeout(30_000, () => socket.destroy(new Error("ClamAV scan timed out")));
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      const buffer = Buffer.from(data);
      for (let offset = 0; offset < buffer.length; offset += 8192) {
        const chunk = buffer.subarray(offset, offset + 8192);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length);
        socket.write(size);
        socket.write(chunk)
      }
      socket.write(Buffer.alloc(4))
    });
    socket.on("data", chunk => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString().includes("FOUND") ? "infected" : "clean"));
    socket.on("error", reject)
  })
}

function address(value: string) {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim().toLowerCase()
}

export async function persistInbound(input: {
  providerAccountId: string;
  webhookEndpointId: string;
  rawEventId: string;
  message: CanonicalInboundMessage
}) {
  const message = input.message;
  const duplicate = (await query<{
    id: string
  }>("SELECT id FROM inbound_messages WHERE provider_account_id=$1 AND external_message_id=$2", [input.providerAccountId, message.externalMessageId])).rows[0];
  if (duplicate) return duplicate.id;
  const recipients = message.to.map(address);
  const route = await transaction(async client => (await client.query<{
    id: string;
    product_id: string;
    service_id: string | null;
    callback_endpoint_id: string | null
  }>(`SELECT r.id,r.product_id,r.service_id,r.callback_endpoint_id FROM inbound_routes r JOIN sending_domains d ON d.id=r.sending_domain_id WHERE r.provider_webhook_endpoint_id=$1 AND r.status='active' AND d.status='active' AND d.inbound_enabled=true AND EXISTS (SELECT 1 FROM unnest($2::text[]) recipient WHERE split_part(recipient,'@',2)=d.domain AND (r.local_part_pattern='*' OR split_part(recipient,'@',1) LIKE replace(r.local_part_pattern,'*','%'))) ORDER BY (r.local_part_pattern<>'*') DESC LIMIT 1`, [input.webhookEndpointId, recipients])).rows[0] ?? null);
  if (!route) throw new Error("No inbound route matched the recipients");
  const id = createId("inb");
  const inserted = await query(`INSERT INTO inbound_messages(id,inbound_route_id,product_id,service_id,provider_account_id,raw_provider_event_id,external_message_id,message_id,from_email,to_emails,cc_emails,bcc_emails,subject,sanitized_html,text_body,status,received_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'scanning',$16) ON CONFLICT(provider_account_id,external_message_id) DO NOTHING RETURNING id`, [id, route.id, route.product_id, route.service_id, input.providerAccountId, input.rawEventId, message.externalMessageId, message.messageId ?? null, address(message.from), recipients, message.cc.map(address), message.bcc.map(address), message.subject, message.html ? sanitizeHtml(message.html) : null, message.text ?? null, message.receivedAt]);
  if (!inserted.rowCount) return (await query<{
    id: string
  }>("SELECT id FROM inbound_messages WHERE provider_account_id=$1 AND external_message_id=$2", [input.providerAccountId, message.externalMessageId])).rows[0].id;
  const prefix = `inbound/${id}`;
  let rawKey: string | null = null;
  const attachments: Array<(typeof message.attachments)[number] & { objectKey: string; scanStatus: "clean" }> = [];
  try {
    const aggregateBytes = message.rawMime?.byteLength ?? message.attachments.reduce((total, file) => total + file.content.byteLength, 0);
    if (aggregateBytes > MAX_MESSAGE_BYTES) throw new Error("Inbound message exceeds the size limit");
    for (const file of message.attachments) if (file.content.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment exceeds the size limit: ${file.fileName}`);
    if (message.rawMime) {
      rawKey = `${prefix}/raw.eml`;
      await objectStore().put(rawKey, message.rawMime, "message/rfc822")
    }
    for (const file of message.attachments) {
      const scanStatus = await scan(file.content);
      if (scanStatus === "infected") throw new Error(`Malware detected in attachment: ${file.fileName}`);
      const key = `${prefix}/attachments/${createId("file")}`;
      await objectStore().put(key, file.content, file.contentType);
      attachments.push({ ...file, objectKey: key, scanStatus })
    }
    await transaction(async client => {
      await client.query("UPDATE inbound_messages SET raw_mime_object_key=$2,status='ready',rejection_reason=NULL WHERE id=$1", [id, rawKey]);
      for (const file of attachments) await client.query("INSERT INTO inbound_attachments(id,inbound_message_id,file_name,content_type,size_bytes,object_key,content_id,scan_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [createId("ina"), id, file.fileName, file.contentType, file.content.byteLength, file.objectKey, file.contentId ?? null, file.scanStatus]);
      if (route.callback_endpoint_id) {
        const callbackId = createId("cbx");
        const payload = {
          id: createId("event"),
          apiVersion: "2026-09-01",
          type: "inbound.received",
          occurredAt: message.receivedAt.toISOString(),
          data: {
            inboundMessageId: id,
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
        await client.query("INSERT INTO callback_deliveries(id,endpoint_id,inbound_message_id,event_type,payload) VALUES ($1,$2,$3,'inbound.received',$4)", [callbackId, route.callback_endpoint_id, id, payload]);
        await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'callback',$2,'callback.requested',$3)", [createId("out"), callbackId, { callbackDeliveryId: callbackId }])
      }
    })
  } catch (error) {
    await query("UPDATE inbound_messages SET status='rejected',rejection_reason=$2 WHERE id=$1", [id, error instanceof Error ? error.message : "Inbound processing failed"])
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
  const message = await input.receive(input.verified);
  if (!message) return null;
  return persistInbound({ ...input, message })
}
