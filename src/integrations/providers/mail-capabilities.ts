import { CanonicalProviderError, type CanonicalMessage, type EmailAddress, type ProviderCapabilities } from "./contracts";

export const nativeMailCapabilities = {
    inboundEnvelopeRecipients: false,
    cc: true, bcc: true, replyTo: true, customHeaders: true, threading: true,
    outboundAttachments: true, inlineAttachments: true, envelopeRecipients: false,
    requiresTo: true, maxRecipients: 50, maxMessageBytes: 10000000
} as const;
export function formatAddress(address: EmailAddress) {
    return address.name ? `${JSON.stringify(address.name)} <${address.email}>` : address.email;
}
export function messageHeaders(message: CanonicalMessage) {
    return {
        ...message.headers,
        ...(message.inReplyTo ? { "In-Reply-To": message.inReplyTo } : {}),
        ...(message.references.length ? { References: message.references.join(" ") } : {})
    };
}
export function messageRecipients(message: Pick<CanonicalMessage, "to" | "cc" | "bcc" | "envelopeRecipients">) {
    return message.envelopeRecipients ?? [...message.to, ...message.cc, ...message.bcc];
}
/** Conservative encoded size, including MIME and JSON/base64 overhead. */
export function estimatedMessageBytes(message: Pick<CanonicalMessage, "from" | "to" | "cc" | "bcc" | "replyTo" | "subject" | "html" | "text" | "headers" | "attachments">) {
    const { attachments, ...fields } = message;
    return Buffer.byteLength(JSON.stringify(fields), "utf8") * 2 + attachments.reduce((size, attachment) => size + Math.ceil(attachment.content.byteLength / 3) * 4 + 2048, 0) + 8192;
}
export function assertMessageCapabilities(message: CanonicalMessage, capabilities: ProviderCapabilities) {
    const unsupported = (feature: string) => { throw new CanonicalProviderError(`Provider cannot preserve ${feature}`, "policy", "UNSUPPORTED_MAIL_FEATURE", "not_accepted", false, { stage: "routing", providerCode: feature }); };
    if (message.cc.length && !capabilities.cc)
        unsupported("cc");
    if (message.bcc.length && !capabilities.bcc)
        unsupported("bcc");
    if (message.replyTo.length && !capabilities.replyTo)
        unsupported("replyTo");
    if (Object.keys(message.headers).length && !capabilities.customHeaders)
        unsupported("customHeaders");
    if ((message.inReplyTo || message.references.length) && !capabilities.threading)
        unsupported("threading");
    if (message.attachments.length && !capabilities.outboundAttachments)
        unsupported("outboundAttachments");
    if (message.attachments.some(a => a.disposition === "inline") && !capabilities.inlineAttachments)
        unsupported("inlineAttachments");
    if (message.envelopeRecipients && !capabilities.envelopeRecipients)
        unsupported("independent envelope recipients");
    if (!message.to.length && capabilities.requiresTo)
        unsupported("email without a To recipient");
    const recipients = messageRecipients(message);
    if (!recipients.length || recipients.length > capabilities.maxRecipients)
        unsupported("recipient count");
    if (estimatedMessageBytes(message) > capabilities.maxMessageBytes)
        unsupported("message size");
    if (capabilities.tagValuePattern && Object.entries(message.tags).some(([key, value]) => !/^[A-Za-z0-9_-]{1,256}$/.test(key) || !new RegExp(capabilities.tagValuePattern!).test(value)))
        unsupported("native tag characters");
    const headerFields = [message.from, ...message.to, ...message.cc, ...message.bcc, ...message.replyTo, ...recipients];
    if (headerFields.some(a => /[\r\n\u0000]/.test(a.email + (a.name ?? ""))) || /[\r\n\u0000]/.test(message.subject))
        unsupported("unsafe header values");
    for (const [name, value] of Object.entries(messageHeaders(message))) {
        if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || /[\r\n\u0000]/.test(value) || /^(?:to|cc|bcc|from|sender|subject|reply-to|return-path|received|dkim-signature|authentication-results|content-.+|mime-version|date|message-id)$/i.test(name))
            unsupported("reserved or unsafe headers");
        if (!/[^\x20-\x7e]/.test(value) && value.split(/\s+/).some(token => Buffer.byteLength(token) > 997))
            unsupported("RFC header line length");
    }
    if (message.attachments.some(a => /[\r\n\u0000]/.test(a.fileName + a.contentType + (a.contentId ?? "")) || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(a.contentType) || (a.disposition === "inline" && !a.contentId)))
        unsupported("invalid attachment metadata");
}
