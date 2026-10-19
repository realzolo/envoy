import { openSecret, sealSecret } from "@/platform/crypto/envelope";
import type { MessageContent } from "../contracts";
import { assertSendDeadline, SendDeadlineError, SENSITIVE_SUBJECT } from "../domain/deadline";
export function persistedContent(content: MessageContent): MessageContent {
    if (content.content_policy !== "sensitive")
        return content;
    const { subject, html_body, text_body, sender_snapshot, to_recipients, cc_recipients, bcc_recipients, reply_to, headers, in_reply_to, references_ids, attachment_snapshot, provider_tags, metadata } = content;
    return { ...content, subject: SENSITIVE_SUBJECT, html_body: null, text_body: null,
        sender_snapshot: { ...sender_snapshot, fromName: undefined },
        to_recipients: to_recipients.map(({ email }) => ({ email })),
        cc_recipients: cc_recipients.map(({ email }) => ({ email })),
        bcc_recipients: bcc_recipients.map(({ email }) => ({ email })),
        reply_to: [], headers: {}, in_reply_to: null, references_ids: [], attachment_snapshot: attachment_snapshot.map(file => ({ ...file, fileName: "[Sensitive attachment]", contentId: null })), provider_tags: {}, metadata: {},
        sensitive_content: sealSecret({ subject, html_body, text_body, sender_snapshot, to_recipients, cc_recipients,
            bcc_recipients, reply_to, headers, in_reply_to, references_ids, attachment_snapshot, provider_tags, metadata }, `message-content:${content.id}`, 1) };
}
/** Internal send preparation only. APIs/admin never call this function. */
export function sendingContent(content: MessageContent): MessageContent {
    assertSendDeadline(content.send_before);
    if (content.content_policy !== "sensitive")
        return content;
    if (!content.sensitive_content)
        throw new SendDeadlineError();
    return { ...content, ...openSecret<Partial<MessageContent>>(content.sensitive_content, `message-content:${content.id}`, 1) };
}
