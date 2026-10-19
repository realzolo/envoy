import { Resend } from "resend";
import { Webhook } from "svix";
import { MAX_FILE_BYTES } from "@/lib/contracts";
import { type CanonicalEventType, type ManagedIdentityStatus, type ProviderModule } from "../contracts";
import { inboundHeaders, smtpRecipients } from "../inbound-fields";
import { accepted, assertMessageCapabilities, checkedJson, event, eventDate, formatAddress, header, messageHeaders, nativeMailCapabilities, safeDiagnostic, stableEventId, submitRequest } from "../shared";
function client(secret: {
    type: string;
    apiKey?: string;
}) {
    if (secret.type !== "resend" || !secret.apiKey)
        throw new Error("Invalid Resend credential");
    return new Resend(secret.apiKey);
}
const eventMap: Record<string, CanonicalEventType> = {
    "email.sent": "accepted", "email.delivered": "delivered", "email.delivery_delayed": "deferred",
    "email.bounced": "bounced", "email.failed": "failed", "email.opened": "opened",
    "email.clicked": "clicked", "email.complained": "complained", "email.suppressed": "suppressed",
    "email.received": "inbound.received",
};
function inboundRoutingReceipt(verified: { nativeType: string; parsed: unknown }) {
    if (verified.nativeType !== "email.received") return null;
    const payload = verified.parsed as { data?: Record<string, unknown> };
    const data = payload?.data;
    if (!data || typeof data.email_id !== "string" || !data.email_id) return null;
    const receivedFor = smtpRecipients(data.received_for);
    const envelopeRecipients = receivedFor?.length ? receivedFor : [
        ...(smtpRecipients(data.to) ?? []),
        ...(smtpRecipients(data.cc) ?? []),
        ...(smtpRecipients(data.bcc) ?? []),
    ];
    return { externalMessageId: data.email_id, envelopeRecipients };
}
async function downloadInboundAttachment(url: string) {
    if (new URL(url).protocol !== "https:") throw new Error("Resend attachment URL must use HTTPS");
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body) throw new Error(`Resend attachment download failed: ${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (contentLength > MAX_FILE_BYTES) throw new Error("Resend attachment exceeds the size limit");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_FILE_BYTES) throw new Error("Resend attachment exceeds the size limit");
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
}
// Resend exposes richer domain states than Envoy's routing model. A partially
// verified domain must remain ineligible for sending until all required DNS is ready.
export function resendIdentityStatus(status: string): ManagedIdentityStatus {
    if (status === "verified")
        return "verified";
    if (status === "failed")
        return "failed";
    return "pending";
}
export const resendModule: ProviderModule = {
    descriptor: {
        type: "resend",
        displayName: "Resend",
        capabilities: {
            nativeIdempotency: true,
            inboundMode: "webhook-fetch",
            domainManagement: true,
            webhookSecurity: "Svix HMAC",
            eventTypes: Object.keys(eventMap),
            ...nativeMailCapabilities,
            inboundEnvelopeRecipients: true,
            maxMessageBytes: 40000000,
            tagValuePattern: "^[A-Za-z0-9_-]{0,256}$",
            scheduling: false
        }
    },
    sender: {
        async send(message, context) {
            assertMessageCapabilities(message, resendModule.descriptor.capabilities);
            if (context.config.type !== "resend")
                throw new Error("Invalid Resend configuration");
            if (context.secret.type !== "resend")
                throw new Error("Invalid Resend credential");
            const response = await submitRequest("https://api.resend.com/emails", {
                method: "POST",
                headers: { authorization: `Bearer ${context.secret.apiKey}`, "content-type": "application/json", ...(context.idempotencyKey ? { "idempotency-key": context.idempotencyKey } : {}) },
                body: JSON.stringify({
                    from: formatAddress(message.from),
                    to: message.to.map(formatAddress),
                    cc: message.cc.length ? message.cc.map(formatAddress) : undefined,
                    bcc: message.bcc.length ? message.bcc.map(formatAddress) : undefined,
                    reply_to: message.replyTo.length ? message.replyTo.map(formatAddress) : undefined,
                    subject: message.subject,
                    html: message.html,
                    text: message.text,
                    headers: messageHeaders(message),
                    attachments: message.attachments.map(a => ({ filename: a.fileName, content_type: a.contentType, content: Buffer.from(a.content).toString("base64"), ...(a.disposition === "inline" ? { content_id: a.contentId } : {}) })),
                    tags: Object.entries(message.tags).map(([name, value]) => ({ name, value }))
                })
            });
            const body = await checkedJson(response);
            return accepted(body.id);
        }
    },
    webhook: {
        async verify(request, _context, security) {
            const secret = typeof security.signingSecret === "string" ? security.signingSecret : "";
            if (!secret)
                return { valid: false, replaySafe: false, nativeType: "unknown", parsed: null };
            try {
                const body = new TextDecoder().decode(request.rawBody);
                new Webhook(secret).verify(body, {
                    "svix-id": header(request.headers, "svix-id"),
                    "svix-timestamp": header(request.headers, "svix-timestamp"),
                    "svix-signature": header(request.headers, "svix-signature")
                });
                const parsed = JSON.parse(body) as Record<string, unknown>;
                const timestamp = Number(header(request.headers, "svix-timestamp"));
                return {
                    valid: true,
                    replaySafe: Number.isFinite(timestamp) && Math.abs(Date.now() / 1000 - timestamp) < 300,
                    providerEventId: header(request.headers, "svix-id"),
                    nativeType: String(parsed.type ?? "unknown"),
                    parsed
                };
            }
            catch {
                return { valid: false, replaySafe: false, nativeType: "unknown", parsed: null };
            }
        },
        async normalize(verified) {
            const payload = verified.parsed as {
                type?: string;
                created_at?: string;
                data?: Record<string, unknown>;
            };
            const type = eventMap[String(payload.type)];
            if (!type)
                return [];
            const data = payload.data ?? {};
            if (type === "inbound.received") {
                const routing = inboundRoutingReceipt(verified);
                if (!routing) return [];
                return [event({
                    id: verified.providerEventId ?? stableEventId(payload),
                    externalMessageId: routing.externalMessageId,
                    type,
                    occurredAt: eventDate(payload.created_at),
                    inboundReference: routing.externalMessageId
                })];
            }
            const bounce = data.bounce as {
                type?: string;
                message?: string;
            } | undefined;
            const failed = data.failed as {
                reason?: string;
            } | undefined;
            return [event({
                    id: verified.providerEventId ?? stableEventId(payload),
                    externalMessageId: typeof data.email_id === "string" ? data.email_id : undefined,
                    type,
                    occurredAt: eventDate(payload.created_at),
                    // Current Resend events contain exactly one recipient in `to`.
                    // An unexpected multi-address payload must retain message scope.
                    recipient: typeof data.recipient === "string" ? data.recipient : Array.isArray(data.to) && data.to.length === 1 && typeof data.to[0] === "string" ? data.to[0] : undefined,
                    bounce: type === "bounced" ? {
                        classification: bounce?.type === "Permanent" ? "hard" : "soft",
                        message: bounce?.message
                    } : undefined,
                    metadata: failed?.reason ? { reason: safeDiagnostic(failed.reason), providerCode: failed.reason } : {}
                })];
        },
    },
    inbound: {
        routingReceipt: inboundRoutingReceipt,
        async receive(verified, context) {
            const routing = inboundRoutingReceipt(verified);
            if (!routing) return null;
            const resend = client(context.secret);
            const result = await resend.emails.receiving.get(routing.externalMessageId, { html_format: "cid" });
            if (result.error || !result.data) throw new Error(result.error?.message ?? "Resend received email retrieval failed");
            const message = result.data;
            if (message.id !== routing.externalMessageId) throw new Error("Resend received email ID changed");
            const fields = await inboundHeaders(message.headers);
            const attachments = [];
            for (const item of message.attachments ?? []) {
                if (item.size > MAX_FILE_BYTES) throw new Error("Resend attachment exceeds the size limit");
                const detail = await resend.emails.receiving.attachments.get({ emailId: message.id, id: item.id });
                if (detail.error || !detail.data) throw new Error(detail.error?.message ?? "Resend attachment retrieval failed");
                if (detail.data.id !== item.id) throw new Error("Resend attachment ID changed");
                attachments.push({
                    fileName: item.filename ?? detail.data.filename ?? "attachment",
                    contentType: item.content_type || detail.data.content_type || "application/octet-stream",
                    contentId: item.content_id ?? undefined,
                    content: await downloadInboundAttachment(detail.data.download_url)
                });
            }
            return {
                externalMessageId: message.id,
                messageId: fields.messageId ?? message.message_id,
                envelopeRecipients: routing.envelopeRecipients,
                from: message.from,
                to: smtpRecipients(message.to) ?? [],
                cc: smtpRecipients(message.cc) ?? [],
                bcc: smtpRecipients(message.bcc) ?? [],
                replyTo: fields.replyTo.length ? fields.replyTo : smtpRecipients(message.reply_to) ?? [],
                inReplyTo: fields.inReplyTo,
                references: fields.references,
                subject: message.subject,
                html: message.html ?? undefined,
                text: message.text ?? undefined,
                attachments,
                authorDate: fields.authorDate,
                receivedAt: eventDate(message.created_at)
            };
        }
    },
    identity: {
        async createIdentity(domain, context) {
            const resend = client(context.secret);
            let after: string | undefined;
            for (;;) {
                const listed = await resend.domains.list({ limit: 100, ...(after ? { after } : {}) });
                if (listed.error || !listed.data)
                    throw new Error(listed.error?.message ?? "Domain lookup failed");
                const existing = listed.data.data.find(item => item.name.toLowerCase() === domain.toLowerCase());
                if (existing) {
                    const result = await resend.domains.get(existing.id);
                    if (result.error || !result.data)
                        throw new Error(result.error?.message ?? "Identity lookup failed");
                    return { externalIdentityId: result.data.id, status: resendIdentityStatus(result.data.status), dnsRecords: result.data.records ?? [] };
                }
                if (!listed.data.has_more)
                    break;
                const next = listed.data.data.at(-1)?.id;
                if (!next || next === after)
                    throw new Error("Domain lookup returned an invalid pagination cursor");
                after = next;
            }
            const result = await resend.domains.create({ name: domain, region: "us-east-1" });
            if (result.error || !result.data)
                throw new Error(result.error?.message ?? "Identity creation failed");
            return { externalIdentityId: result.data.id, status: resendIdentityStatus(result.data.status), dnsRecords: result.data.records ?? [] };
        },
        async checkIdentity(id, context) {
            const result = await client(context.secret).domains.get(id);
            if (result.error || !result.data)
                throw new Error(result.error?.message ?? "Identity lookup failed");
            return { status: resendIdentityStatus(result.data.status), dnsRecords: result.data.records ?? [] };
        },
    },
    reconciliation: {
        async reconcile(externalMessageId, _fingerprint, context) {
            if (!externalMessageId)
                return "unknown";
            const result = await client(context.secret).emails.get(externalMessageId);
            return result.data ? "accepted" : result.error?.name === "not_found" ? "not_accepted" : "unknown";
        }
    },
    health: {
        async check(context) {
            const result = await client(context.secret).domains.list();
            return {
                healthy: !result.error,
                details: { domainCount: result.data?.data.length ?? 0, error: result.error?.message }
            };
        }
    },
};
