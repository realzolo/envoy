import { openSecret, sealSecret } from "@/modules/config/envelope";
import type { MessageContent } from "./native";
import { cleanupOrphanObjects } from "@/server/services/object-cleanup";
import { db, transaction } from "@/server/database";

export const messagePolicies = {
  sendBefore: true,
  contentPolicies: ["normal", "sensitive"],
  sensitive: { requiresSendBefore: true, maxRetentionSeconds: 900, contentReadable: false },
} as const;
export const SENSITIVE_SUBJECT = "[Sensitive content]";
export const DEADLINE_CODE = "SEND_DEADLINE_EXCEEDED";
export const DEADLINE_MESSAGE = "The message sending deadline has passed; no new provider submission is allowed.";
export class SendDeadlineError extends Error {
  readonly code = DEADLINE_CODE;
  constructor() { super(DEADLINE_MESSAGE); }
}
export function assertSendDeadline(sendBefore?: Date | string | null, now = Date.now()) {
  if (sendBefore && new Date(sendBefore).getTime() <= now) throw new SendDeadlineError();
}
export function persistedContent(content: MessageContent): MessageContent {
  if (content.content_policy !== "sensitive") return content;
  const { subject, html_body, text_body, sender_snapshot, to_recipients, cc_recipients, bcc_recipients,
    reply_to, headers, in_reply_to, references_ids, attachment_snapshot, provider_tags, metadata } = content;
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
  if (content.content_policy !== "sensitive") return content;
  if (!content.sensitive_content) throw new SendDeadlineError();
  return { ...content, ...openSecret<Partial<MessageContent>>(content.sensitive_content, `message-content:${content.id}`, 1) };
}
/** Mandatory privacy cleanup independent of optional normal-message retention. Receipts/callbacks remain live. */
export async function purgeExpiredSensitiveContent(limit = 200) {
  const messages = await transaction(async client => {
    const rows = await client.query<{ id: string }>(`SELECT id FROM messages WHERE sensitive_content IS NOT NULL
      AND send_before<=clock_timestamp() ORDER BY send_before,id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
    for (const row of rows.rows) await client.query(`UPDATE messages SET sensitive_content=NULL,
      sensitive_content_purged_at=clock_timestamp() WHERE id=$1`, [row.id]);
    return rows.rowCount ?? 0;
  });
  const receipts = await transaction(async client => {
    const raw = await client.query<{ id: string; raw_object_key: string | null; receipt_object_key: string | null }>(`SELECT id,raw_object_key,verification->>'objectKey' AS receipt_object_key
      FROM raw_provider_events WHERE payload_expires_at<=clock_timestamp() AND raw_payload_purged_at IS NULL AND normalized_events IS NOT NULL
      ORDER BY payload_expires_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
    for (const item of raw.rows) {
      for (const key of [item.raw_object_key,item.receipt_object_key]) if (key) await client.query("INSERT INTO pending_object_deletions(object_key,available_at) VALUES($1,clock_timestamp()) ON CONFLICT(object_key) DO UPDATE SET available_at=EXCLUDED.available_at", [key]);
      await client.query(`UPDATE raw_provider_events SET raw_body=NULL,raw_object_key=NULL,verification='{}',headers='{}',
        raw_payload_purged_at=clock_timestamp() WHERE id=$1`, [item.id]);
    }
    return raw.rowCount ?? 0;
  });
  const client = await db().connect();
  try { await cleanupOrphanObjects(client, true, limit); } finally { client.release(); }
  return messages + receipts;
}
