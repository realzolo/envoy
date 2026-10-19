import type { InboundInput, InboundDispatch } from "../contracts";
import type { CanonicalInboundMessage, WebhookVerification } from "@/integrations/providers/contracts";
import { MAX_FILE_BYTES } from "@/lib/contracts";
import { InboundTerminalError, address, authorDate, MAX_MESSAGE_BYTES } from "../domain/message";
import type { InboundDependencies } from "./ports";

export function createInboundService(dependencies: InboundDependencies) {
async function persistInbound(input: InboundInput) {
  // Empty/invalid envelopes are quarantined, never replaced with visible To/Cc or arbitrary headers.
  const supplied = input.message.envelopeRecipients;
  const recipients = supplied?.length && supplied.every(item => /^[^\s<>@,]+@[^\s<>@,]+$/.test(item))
    ? [...new Set(supplied.map(address))] : [];
  // Freeze the complete dispatch plan at the first durable processing decision.
  // Concurrent retries read the winner; later binding changes never expand historical access.
  const receipt = await dependencies.unitOfWork.run(async client => {
    const existing = (await client.readReceipt({ accountId: input.providerAccountId, externalId: input.message.externalMessageId })).rows[0];
    if (existing) return existing;
    const proposed = recipients.length ? (await client.findDispatches({ endpointId: input.webhookEndpointId, recipients, accountId: input.providerAccountId })).rows : [];
    await client.freezeReceipt({ accountId: input.providerAccountId, externalId: input.message.externalMessageId, routesJson: JSON.stringify(proposed), rawEventId: input.rawEventId });
    return (await client.readReceipt({ accountId: input.providerAccountId, externalId: input.message.externalMessageId })).rows[0];
  });
  if (receipt.terminated_at) throw new InboundTerminalError("INBOUND_RECEIPT_TERMINATED");
  const routes = receipt.routes;
  input = { ...input, ingressReceivedAt: receipt.ingress_received_at };
  if (!routes.length) {
    if (recipients.length) return persistInboundCopy({ ...input, message: { ...input.message, envelopeRecipients: recipients } }, "quarantine", null);
    const tombstone = (await dependencies.repository.findTombstone({ accountId: input.providerAccountId, externalId: input.message.externalMessageId })).rows[0];
    if (tombstone) return tombstone.id;
    const stored = await dependencies.repository.insertRejected({ id: dependencies.id("inb"), accountId: input.providerAccountId, rawEventId: input.rawEventId, externalId: input.message.externalMessageId, messageId: input.message.messageId??null, from: address(input.message.from), to: input.message.to, cc: input.message.cc, bcc: input.message.bcc, subject: input.message.subject, html: input.message.html?dependencies.sanitizeHtml(input.message.html):null, text: input.message.text??null, reason: "ENVELOPE_RECIPIENT_UNAVAILABLE", receivedAt: input.ingressReceivedAt, envelope: recipients, replyTo: input.message.replyTo??[], inReplyTo: input.message.inReplyTo??null, references: input.message.references??[], authorDate: authorDate(input.message.authorDate) });
    return stored.rows[0].id;
  }
  // One private projection per Service, even when several Services share a domain.
  const groups = new Map<string, InboundDispatch[]>();
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
      const id = await persistInboundCopy({ ...input, message }, scope, scope);
      firstId ||= id;
    } catch (error) {
      if (error instanceof InboundTerminalError && error.code === "DOMAIN_RECEIVE_NOT_AUTHORIZED") continue;
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures,"Inbound copies require retry");
  return firstId;
}

async function persistInboundCopy(input: InboundInput, scope: string, serviceId: string | null) {
  const envelopeRecipients=input.message.envelopeRecipients??[];
  if (serviceId) {
    const allowed=(await dependencies.repository.allowedDomains({ serviceId })).rows.map(row=>row.domain);
    if(!envelopeRecipients.length || envelopeRecipients.some(recipient=>!allowed.includes(recipient.split('@')[1])))
      throw new InboundTerminalError("Domain receiving permission was revoked","DOMAIN_RECEIVE_NOT_AUTHORIZED");
  }
  const message = {...input.message,envelopeRecipients,bcc:input.message.bcc.filter(item=>envelopeRecipients.includes(address(item)))};
  const duplicate = (await dependencies.repository.findCopy({ accountId: input.providerAccountId, externalId: message.externalMessageId, scope: scope })).rows[0];
  if (duplicate?.content_purged_at) return duplicate.id;
  if (duplicate && duplicate.status !== "scanning") return duplicate.id;
  let id = duplicate?.id ?? dependencies.id("inb");
  const recipients = message.to.map(address);
  const inserted = duplicate ? null : await dependencies.repository.insertCopy({ id: id, serviceId, accountId: input.providerAccountId, rawEventId: input.rawEventId, externalId: message.externalMessageId, messageId: message.messageId ?? null, from: address(message.from), to: recipients, cc: message.cc.map(address), bcc: message.bcc.map(address), subject: message.subject, html: message.html ? dependencies.sanitizeHtml(message.html) : null, text: message.text ?? null, receivedAt: input.ingressReceivedAt, scope: scope, envelope: message.envelopeRecipients, replyTo: message.replyTo??[], inReplyTo: message.inReplyTo??null, references: message.references??[] });
  if (inserted && !inserted.rowCount) {
    const existing = (await dependencies.repository.findConcurrentCopy({ accountId: input.providerAccountId, externalId: message.externalMessageId, scope: scope })).rows[0];
    if (!existing) throw new Error("Inbound message was not persisted");
    if (existing.status !== "scanning") return existing.id;
    id = existing.id;
  }
  await dependencies.repository.recordDates({ id: id, ingressReceivedAt: input.ingressReceivedAt, authorDate: authorDate(message.authorDate) });
  const token = dependencies.id("claim");
  const claimed = await dependencies.repository.claimCopy({ id: id, token: token });
  if (!claimed.rowCount) {
    const current = (await dependencies.repository.copyState({ id: id })).rows[0];
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
      attachments.push({ ...file, objectKey: `${prefix}/attachments/${index}`, sha256: dependencies.digest(file.content) });
    }
    if (message.rawMime) {
      rawKey = `${prefix}/raw.eml`;
      writtenKeys.push(rawKey);
      await dependencies.uploads.register(rawKey);
      await dependencies.uploads.put(rawKey, message.rawMime, "message/rfc822");
    }
    for (const file of attachments) {
      const renewed = await dependencies.repository.renewClaim({ id: id, token: token });
      if (!renewed.rowCount) throw new Error("Inbound processing ownership expired");
      writtenKeys.push(file.objectKey);
      await dependencies.uploads.register(file.objectKey);
      await dependencies.uploads.put(file.objectKey, file.content, file.contentType);
    }
    await dependencies.unitOfWork.run(async client => {
      if (serviceId && !(await client.authorizeCompletion({ id: id })).rowCount) {
        throw new InboundTerminalError("Domain receiving permission was revoked", "DOMAIN_RECEIVE_NOT_AUTHORIZED");
      }
      const completed = await client.completeCopy({ id: id, rawKey: rawKey, token: token });
      if (!completed.rowCount) throw new Error("Inbound processing ownership expired");
      for (const file of attachments) {
        const attachmentId=dependencies.id("ina");
        await client.insertAttachment({ id: attachmentId, messageId: id, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.content.byteLength, objectKey: file.objectKey, contentId: file.contentId ?? null, digest: file.sha256 });
        await client.registerAttachment(attachmentId,"inbound",serviceId,file.sha256);
      }
      await client.completeUploads( writtenKeys);
      const callback = serviceId ? await client.subscribedCallbacks({ serviceId }) : { rows: [] };
      for (const {id:callbackEndpointId} of callback.rows) {
        const callbackId = dependencies.id("cbx");
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

            serviceId,
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
        await client.insertCallback({ id: callbackId, endpointId: callbackEndpointId, messageId: id, payload: payload });
        await client.enqueueCallback({ outboxId: dependencies.id("out"), id: callbackId, payload: { callbackDeliveryId: callbackId } })
      }
    })
  } catch (error) {
    // COMMIT itself may have lost its response: reference-aware cleanup must decide what is orphaned.
    await Promise.allSettled(writtenKeys.map(key => dependencies.uploads.register(key)));
    if (error instanceof InboundTerminalError) {
      await dependencies.repository.rejectCopy({ id: id, reason: error.code, token: token });
      return id;
    }
    await dependencies.repository.releaseClaim({ id: id, token: token });
    throw error;
  }
  return id;
}

async function processInboundEvent(input: {
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

return { persistInbound, processInboundEvent };
}
