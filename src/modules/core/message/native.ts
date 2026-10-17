import type { PoolClient } from "pg";
import type { CanonicalMessage, EmailAddress, ProviderCapabilities } from "@/modules/providers/contracts";
import { assertMessageCapabilities, estimatedMessageBytes } from "@/modules/providers/shared";
import type { ServiceIdentity } from "@/server/auth";

export type StoredAttachment = {
  fileId: string; fileName: string; contentType: string; size: number; sha256: string; objectKey: string;
  disposition: "attachment" | "inline"; contentId: string | null;
};
export type MessageContent = {
  id: string; product_id: string; service_id: string; sending_domain_id: string;
  sender_snapshot: { product: string; fromName?: string; fromEmail: string; domainId: string };
  to_recipients: EmailAddress[]; cc_recipients: EmailAddress[]; bcc_recipients: EmailAddress[];
  reply_to: EmailAddress[]; subject: string; html_body: string | null; text_body: string | null;
  headers: Record<string, string>; in_reply_to: string | null; references_ids: string[];
  attachment_snapshot: StoredAttachment[]; provider_tags: Record<string, string>; message_category: string;
  content_purged_at: Date | null; metadata: Record<string, string>;
};

export async function authorizedDomain(client: PoolClient, identity: Pick<ServiceIdentity, "productId" | "serviceId">, email: string) {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  return (await client.query<{ id: string }>(`SELECT sd.id FROM sending_domains sd
    JOIN sender_grants g ON g.sending_domain_id=sd.id AND g.status='active'
    JOIN products p ON p.id=g.product_id AND p.status='active'
    JOIN services s ON s.id=$2 AND s.product_id=p.id
    WHERE sd.domain=$3 AND sd.status='active' AND g.product_id=$1
      AND (g.service_id IS NULL OR g.service_id=$2)
      AND (g.from_local_part IS NULL OR g.from_local_part=$4)
    ORDER BY g.id LIMIT 1`, [identity.productId, identity.serviceId, domain, local])).rows[0]?.id ?? null;
}

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
    if (bytes > capabilities.maxMessageBytes) return "The encoded message exceeds the provider message size limit";
    return null;
  } catch (error) { return error instanceof Error ? error.message : "Unsupported message capability"; }
}

export function subsetEnvelope(message: MessageContent, recipients: EmailAddress[]): EmailAddress[] | undefined {
  const originals = [...message.to_recipients, ...message.cc_recipients, ...message.bcc_recipients];
  const actual = new Set(recipients.map(item => item.email.toLowerCase()));
  return originals.length === actual.size && originals.every(item => actual.has(item.email.toLowerCase())) ? undefined : recipients;
}
