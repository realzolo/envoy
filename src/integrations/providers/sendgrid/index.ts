import { simpleParser } from "mailparser";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import type { CanonicalEventType, ProviderModule } from "../contracts";
import { inboundHeaders, mailAddresses, smtpRecipients } from "../inbound-fields";
import { accepted, assertMessageCapabilities, checkedJson, event, eventDate, header, messageHeaders, type MultipartValue, nativeMailCapabilities, parseMultipart, safeDiagnostic, stableEventId, submitRequest } from "../shared";
const eventMap: Record<string, CanonicalEventType> = {
    processed: "accepted",
    delivered: "delivered",
    deferred: "deferred",
    bounce: "bounced",
    dropped: "failed",
    open: "opened",
    click: "clicked",
    spamreport: "complained",
    unsubscribe: "unsubscribed"
};
function apiBase(region: "global" | "eu") {
    return region === "eu" ? "https://api.eu.sendgrid.com" : "https://api.sendgrid.com";
}
export const sendgridModule: ProviderModule = {
    descriptor: {
        type: "sendgrid",
        displayName: "SendGrid",
        capabilities: {
            nativeIdempotency: false,
            inboundMode: "multipart",
            domainManagement: false,
            webhookSecurity: "ECDSA signed event and inbound webhooks",
            eventTypes: Object.keys(eventMap),
            ...nativeMailCapabilities,
            inboundEnvelopeRecipients: true,
            maxRecipients: 1000,
            maxMessageBytes: 30000000,
            scheduling: false
        }
    },
    sender: {
        async send(message, context) {
            assertMessageCapabilities(message, sendgridModule.descriptor.capabilities);
            if (context.config.type !== "sendgrid" || context.secret.type !== "sendgrid")
                throw new Error("Invalid SendGrid configuration");
            const response = await submitRequest(`${apiBase(context.config.region)}/v3/mail/send`, {
                method: "POST",
                headers: { authorization: `Bearer ${context.secret.apiKey}`, "content-type": "application/json" },
                body: JSON.stringify({
                    personalizations: [{
                            to: message.to,
                            cc: message.cc.length ? message.cc : undefined,
                            bcc: message.bcc.length ? message.bcc : undefined,
                            custom_args: message.tags
                        }],
                    from: message.from,
                    reply_to_list: message.replyTo.length ? message.replyTo : undefined,
                    subject: message.subject,
                    content: [...(message.text ? [{ type: "text/plain", value: message.text }] : []), ...(message.html ? [{ type: "text/html", value: message.html }] : [])],
                    headers: messageHeaders(message),
                    attachments: message.attachments.map(a => ({ filename: a.fileName, type: a.contentType, content: Buffer.from(a.content).toString("base64"), disposition: a.disposition, content_id: a.contentId }))
                })
            });
            if (!response.ok)
                await checkedJson(response);
            return accepted(response.headers.get("x-message-id"));
        }
    },
    webhook: {
        async verify(request, _context, security) {
            const contentType = header(request.headers, "content-type");
            const inbound = contentType.includes("multipart/form-data");
            const publicKey = typeof security[inbound ? "inboundParsePublicKey" : "eventWebhookPublicKey"] === "string"
                ? String(security[inbound ? "inboundParsePublicKey" : "eventWebhookPublicKey"])
                : "";
            const signature = header(request.headers, "x-twilio-email-event-webhook-signature");
            const timestamp = header(request.headers, "x-twilio-email-event-webhook-timestamp");
            if (!publicKey || !signature || !timestamp)
                return {
                    valid: false,
                    replaySafe: false,
                    nativeType: "unknown",
                    parsed: null
                };
            let valid = false;
            try {
                valid = verifySignature("sha256", Buffer.concat([Buffer.from(timestamp), Buffer.from(request.rawBody)]), publicKey.includes("-----BEGIN") ? createPublicKey(publicKey) : createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(signature, "base64"));
            }
            catch {
            }
            if (!valid)
                return { valid: false, replaySafe: false, nativeType: "unknown", parsed: null };
            const replaySafe = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
            if (inbound) {
                const parsed = await parseMultipart(request.rawBody, contentType);
                return {
                    valid,
                    replaySafe,
                    providerEventId: createHash("sha256").update(request.rawBody).digest("hex"),
                    nativeType: "inbound",
                    parsed
                };
            }
            const parsed = JSON.parse(new TextDecoder().decode(request.rawBody)) as unknown;
            const rows = Array.isArray(parsed) ? parsed : [];
            const first = rows[0] as Record<string, unknown> | undefined;
            return {
                valid,
                replaySafe,
                providerEventId: createHash("sha256").update(request.rawBody).digest("hex"),
                nativeType: first?.event ? String(first.event) : "batch",
                parsed
            };
        }, async normalize(verified) {
            if (verified.nativeType === "inbound")
                return [event({
                        id: verified.providerEventId ?? crypto.randomUUID(),
                        type: "inbound.received",
                        occurredAt: new Date(),
                        inboundReference: verified.providerEventId
                    })];
            const rows = verified.parsed as Array<Record<string, unknown>>;
            return rows.flatMap(row => {
                const type = eventMap[String(row.event)];
                if (!type)
                    return [];
                return [event({
                        id: String(row.sg_event_id ?? stableEventId(row)),
                        externalMessageId: typeof row.sg_message_id === "string" ? row.sg_message_id.split(".")[0] : undefined,
                        type,
                        occurredAt: eventDate(Number(row.timestamp) * 1000),
                        recipient: typeof row.email === "string" ? row.email : undefined,
                        bounce: type === "bounced" ? {
                            classification: String(row.type).includes("bounce") ? "hard" : "soft",
                            code: typeof row.status === "string" ? row.status : undefined,
                            message: String(row.reason ?? "")
                        } : undefined,
                        metadata: ["failed", "deferred"].includes(type) ? { reason: safeDiagnostic(row.reason ?? row.response ?? "Provider delivery failed"), ...(row.status ? { providerCode: String(row.status), smtpStatus: String(row.status).match(/\b[245]\.\d{1,3}\.\d{1,3}\b/)?.[0] } : {}) } : {}
                    })];
            });
        }
    },
    inbound: {
        routingReceipt(verified) {
            if (verified.nativeType !== "inbound") return null;
            const p = verified.parsed as Record<string, MultipartValue | MultipartValue[]>;
            const raw = typeof p.envelope === "string" ? p.envelope : "";
            let envelopeRecipients: string[] | undefined;
            try { envelopeRecipients = smtpRecipients(JSON.parse(raw).to); } catch { /* Untrusted or absent envelope. */ }
            return { externalMessageId: verified.providerEventId ?? stableEventId(p), envelopeRecipients };
        },
        async receive(verified) {
            const routing = sendgridModule.inbound!.routingReceipt(verified);
            if (!routing) return null;
            const p = verified.parsed as Record<string, MultipartValue | MultipartValue[]>;
            const text = (key: string) => typeof p[key] === "string" ? p[key] as string : "";
            const mime = text("email") ? await simpleParser(text("email")) : null;
            const fields = await inboundHeaders(text("email") || text("headers"));
            const files = Object.entries(p).filter(([key, value]) => key.startsWith("attachment") && !Array.isArray(value) && typeof value !== "string").map(([, value]) => {
                const file = value as Exclude<MultipartValue, string>;
                return { fileName: file.name, contentType: file.type, content: file.bytes };
            });
            return {
                ...fields,
                externalMessageId: routing.externalMessageId,
                envelopeRecipients: routing.envelopeRecipients,
                from: mime?.from?.text ?? text("from"),
                to: mime ? mailAddresses(mime.to) : (await inboundHeaders(`To: ${text("to")}`)).to,
                cc: mime ? mailAddresses(mime.cc) : (await inboundHeaders(`Cc: ${text("cc")}`)).cc,
                bcc: [],
                subject: mime?.subject ?? text("subject"),
                html: mime ? (typeof mime.html === "string" ? mime.html : undefined) : text("html"),
                text: mime?.text ?? text("text"),
                rawMime: text("email") ? new TextEncoder().encode(text("email")) : undefined,
                attachments: mime ? mime.attachments.map(file => ({ fileName: file.filename ?? "attachment", contentType: file.contentType, content: new Uint8Array(file.content), contentId: file.cid })) : files,
                receivedAt: new Date()
            };
        }
    },
    reconciliation: {
        async reconcile() {
            return "unknown";
        }
    },
    health: {
        async check(context) {
            if (context.config.type !== "sendgrid" || context.secret.type !== "sendgrid")
                throw new Error("Invalid SendGrid configuration");
            // A deliberately invalid Mail Send request validates the permission Envoy
            // actually needs without delivering a probe email or requiring profile.read.
            const response = await fetch(`${apiBase(context.config.region)}/v3/mail/send`, {
                method: "POST",
                headers: { authorization: `Bearer ${context.secret.apiKey}`, "content-type": "application/json" },
                body: "{}"
            });
            return { healthy: [400, 202, 429].includes(response.status), details: { status: response.status } };
        }
    },
};
