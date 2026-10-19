import type { CanonicalMessage, EmailAddress, ProviderCapabilities } from "@/integrations/providers/contracts";
import { assertMessageCapabilities, estimatedMessageBytes } from "@/integrations/providers/mail-capabilities";
import type { MessageContent } from "../contracts";
export function canonicalMessage(message: MessageContent, submissionId: string, envelope?: EmailAddress[]): CanonicalMessage {
    return {
        submissionId,
        from: { email: message.sender_snapshot.fromEmail, ...(message.sender_snapshot.fromName !== undefined ? { name: message.sender_snapshot.fromName } : {}) },
        to: message.to_recipients, cc: message.cc_recipients, bcc: message.bcc_recipients,
        replyTo: message.reply_to, subject: message.subject,
        ...(message.html_body !== null ? { html: message.html_body } : {}),
        ...(message.text_body !== null ? { text: message.text_body } : {}),
        headers: message.headers, inReplyTo: message.in_reply_to ?? undefined, references: message.references_ids,
        attachments: message.attachment_snapshot.map(file => ({
            fileName: file.fileName, contentType: file.contentType, disposition: file.disposition,
            contentId: file.contentId ?? undefined, content: new Uint8Array(),
        })),
        tags: message.provider_tags,
        ...(envelope ? { envelopeRecipients: envelope } : {}),
    };
}
export function capabilityIssue(message: MessageContent, capabilities: ProviderCapabilities, envelope?: EmailAddress[]): string | null {
    try {
        assertMessageCapabilities(canonicalMessage(message, "preflight", envelope), capabilities);
        // Include base64 expansion and conservative MIME/header overhead before choosing a provider.
        const bytes = estimatedMessageBytes(canonicalMessage(message, "preflight", envelope))
            + message.attachment_snapshot.reduce((sum, file) => sum + Math.ceil(file.size / 3) * 4, 0);
        if (bytes > capabilities.maxMessageBytes)
            return "The encoded message exceeds the provider message size limit";
        return null;
    }
    catch (error) {
        return error instanceof Error ? error.message : "Unsupported message capability";
    }
}
export function subsetEnvelope(message: MessageContent, recipients: EmailAddress[]): EmailAddress[] | undefined {
    const originals = [...message.to_recipients, ...message.cc_recipients, ...message.bcc_recipients];
    const actual = new Set(recipients.map(item => item.email.toLowerCase()));
    return originals.length === actual.size && originals.every(item => actual.has(item.email.toLowerCase())) ? undefined : recipients;
}
