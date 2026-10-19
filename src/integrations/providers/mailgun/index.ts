import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CanonicalEventType, ProviderModule } from "../contracts";
import { inboundHeaders } from "../inbound-fields";
import { accepted, assertMessageCapabilities, buildMimeMessage, checkedJson, decodeJson, event, eventDate, header, messageRecipients, type MultipartValue, nativeMailCapabilities, parseMultipart, stableEventId, submitRequest } from "../shared";
const eventMap: Record<string, CanonicalEventType> = {
    accepted: "accepted",
    delivered: "delivered",
    failed: "failed",
    opened: "opened",
    clicked: "clicked",
    complained: "complained",
    unsubscribed: "unsubscribed",
    stored: "inbound.received"
};
export const mailgunModule: ProviderModule = {
    descriptor: {
        type: "mailgun",
        displayName: "Mailgun",
        capabilities: {
            nativeIdempotency: false,
            inboundMode: "route",
            domainManagement: false,
            webhookSecurity: "Timestamp token HMAC",
            eventTypes: Object.keys(eventMap),
            ...nativeMailCapabilities,
            inboundEnvelopeRecipients: true,
            envelopeRecipients: true,
            requiresTo: false,
            maxRecipients: 1000,
            maxMessageBytes: 25000000,
            scheduling: false
        }
    },
    sender: {
        async send(message, context) {
            assertMessageCapabilities(message, mailgunModule.descriptor.capabilities);
            if (context.config.type !== "mailgun" || context.secret.type !== "mailgun")
                throw new Error("Invalid Mailgun configuration");
            const form = new FormData();
            for (const recipient of messageRecipients(message))
                form.append("to", recipient.email);
            form.set("message", new Blob([Buffer.from(buildMimeMessage(message))], { type: "message/rfc822" }), "message.eml");
            for (const [key, value] of Object.entries(message.tags))
                form.set(`v:${key}`, value);
            const host = context.config.region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
            const response = await submitRequest(`${host}/v3/${context.config.sendingDomain}/messages.mime`, {
                method: "POST",
                headers: { authorization: `Basic ${Buffer.from(`api:${context.secret.apiKey}`).toString("base64")}` },
                body: form
            });
            const body = await checkedJson(response);
            return accepted(body.id, undefined, body.id);
        }
    },
    webhook: {
        async verify(request, _context, security) {
            const signingKey = typeof security.webhookSigningKey === "string" ? security.webhookSigningKey : "";
            if (!signingKey)
                return { valid: false, replaySafe: false, nativeType: "unknown", parsed: null };
            const contentType = header(request.headers, "content-type");
            const multipart = contentType.includes("multipart/form-data");
            const parsed = multipart ? await parseMultipart(request.rawBody, contentType) : decodeJson(request.rawBody);
            const value = (key: string) => {
                const v = (parsed as Record<string, unknown>)[key];
                return typeof v === "string" ? v : "";
            };
            const signature = ((parsed as Record<string, unknown>).signature ?? {}) as Record<string, unknown>;
            const timestamp = value("timestamp") || String(signature.timestamp ?? "");
            const token = value("token") || String(signature.token ?? "");
            const actual = value("signature") || String(signature.signature ?? "");
            const data = ((parsed as Record<string, unknown>)["event-data"] ?? {}) as Record<string, unknown>;
            const inbound = typeof (parsed as Record<string, unknown>).recipient === "string" && !data.event;
            const bodySignature = header(request.headers, "x-mailgun-signature");
            const bodyTimestamp = header(request.headers, "x-mailgun-timestamp");
            const signedBody = inbound && contentType.includes("application/json") && Boolean(bodySignature && bodyTimestamp);
            const proofTimestamp = signedBody ? bodyTimestamp : timestamp;
            const expected = createHmac("sha256", signingKey)
                .update(proofTimestamp)
                .update(signedBody ? request.rawBody : Buffer.from(token))
                .digest("hex");
            const suppliedSignature = signedBody ? bodySignature : actual;
            const valid = Boolean(signingKey) && (!inbound || signedBody) && suppliedSignature.length === expected.length
                && timingSafeEqual(Buffer.from(suppliedSignature), Buffer.from(expected));
            return {
                valid,
                replaySafe: Math.abs(Date.now() / 1000 - Number(proofTimestamp)) < 300,
                providerEventId: inbound ? createHash("sha256").update(request.rawBody).digest("hex") : String(data.id ?? token),
                nativeType: inbound ? "inbound" : String(data.event ?? "unknown"),
                parsed
            };
        }, async normalize(verified) {
            if (verified.nativeType === "inbound")
                return [event({
                        id: verified.providerEventId ?? crypto.randomUUID(),
                        type: "inbound.received",
                        occurredAt: eventDate(Number((verified.parsed as Record<string, unknown>).timestamp) * 1000),
                        inboundReference: verified.providerEventId
                    })];
            const payload = verified.parsed as Record<string, unknown>;
            const data = (payload["event-data"] ?? {}) as Record<string, unknown>;
            const type = data.event === "failed" ? data.severity === "temporary" ? "deferred" : "bounced" : eventMap[String(data.event)];
            if (!type)
                return [];
            const message = (data.message ?? {}) as Record<string, unknown>;
            const headers = (message.headers ?? {}) as Record<string, unknown>;
            const recipient = typeof data.recipient === "string" ? data.recipient : undefined;
            return [event({
                    id: String(data.id ?? verified.providerEventId ?? stableEventId(data)),
                    externalMessageId: typeof headers["message-id"] === "string" ? String(headers["message-id"]) : undefined,
                    type,
                    occurredAt: eventDate(Number(data.timestamp) * 1000),
                    recipient,
                    bounce: type === "bounced" || type === "deferred" ? {
                        classification: data.severity === "permanent" ? "hard" : "soft",
                        code: String(((data["delivery-status"] ?? {}) as Record<string, unknown>).code ?? ""),
                        message: String(((data["delivery-status"] ?? {}) as Record<string, unknown>).message ?? "")
                    } : undefined
                })];
        }
    },
    inbound: {
        routingReceipt(verified) {
            if (verified.nativeType !== "inbound") return null;
            const p = verified.parsed as Record<string, MultipartValue | MultipartValue[]>;
            const recipient = typeof p.recipient === "string" && p.recipient ? p.recipient : undefined;
            return { externalMessageId: verified.providerEventId ?? stableEventId(p), envelopeRecipients: recipient ? [recipient] : undefined };
        },
        async receive(verified) {
            const routing = mailgunModule.inbound!.routingReceipt(verified);
            if (!routing) return null;
            const p = verified.parsed as Record<string, MultipartValue | MultipartValue[]>;
            const text = (key: string) => typeof p[key] === "string" ? p[key] as string : "";
            const multipartAttachments = Object.entries(p).filter(([key, value]) => key.startsWith("attachment") && !Array.isArray(value) && typeof value !== "string").map(([, value]) => {
                const file = value as Exclude<MultipartValue, string>;
                return { fileName: file.name, contentType: file.type, content: file.bytes };
            });
            const jsonAttachments = Array.isArray(p.attachments) ? p.attachments.flatMap(item => {
                if (!item || typeof item !== "object") return [];
                const file = item as Record<string, unknown>;
                if (typeof file.content !== "string") return [];
                return [{ fileName: String(file.filename ?? "attachment"), contentType: String(file["content-type"] ?? "application/octet-stream"), content: new Uint8Array(Buffer.from(file.content, "base64")) }];
            }) : [];
            const headers = Array.isArray(p["message-headers"]) ? p["message-headers"] : text("message-headers") ? JSON.parse(text("message-headers")) : "";
            const fields = await inboundHeaders(headers);
            return {
                ...fields,
                externalMessageId: routing.externalMessageId,
                messageId: fields.messageId ?? (text("Message-Id") || undefined),
                envelopeRecipients: routing.envelopeRecipients,
                from: text("from") || text("sender"),
                to: fields.to.length ? fields.to : (await inboundHeaders(`To: ${text("To")}`)).to,
                cc: fields.cc.length ? fields.cc : (await inboundHeaders(`Cc: ${text("Cc")}`)).cc,
                bcc: [],
                subject: text("subject"),
                html: Array.isArray(p["body-html"]) ? p["body-html"].filter((part): part is string => typeof part === "string").join("\n") : text("body-html"),
                text: text("body-plain"),
                rawMime: typeof p["body-mime"] === "string" ? new TextEncoder().encode(p["body-mime"] as string) : undefined,
                attachments: [...multipartAttachments, ...jsonAttachments],
                receivedAt: new Date(Number(text("timestamp") || Date.now() / 1000) * 1000)
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
            if (context.config.type !== "mailgun" || context.secret.type !== "mailgun")
                throw new Error("Invalid Mailgun configuration");
            const host = context.config.region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
            const response = await fetch(`${host}/v3/domains`, { headers: { authorization: `Basic ${Buffer.from(`api:${context.secret.apiKey}`).toString("base64")}` } });
            return { healthy: response.ok, details: { status: response.status } };
        }
    },
};
