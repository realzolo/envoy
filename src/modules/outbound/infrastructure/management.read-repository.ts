import type {DeliveryDetailDto,DeliveryAttemptDto,DeliveryEventDto,MessageContentDto} from '@/modules/admin/contracts';
import type { DeliveryStatus, EmailRecord } from '@/lib/types';
import type { MessageFilters } from '@/modules/admin/contracts';
import { query } from '@/platform/database';
export function createManagementReadRepository(getRetryEligibility: typeof import('../public').getRetryEligibility) {
    type EmailRow = {
        delivery_id: string;
        message_id: string;
        recipient_email: string;
        recipient_name: string | null;
        recipient_role: "to" | "cc" | "bcc";
        last_error: Record<string, unknown> | null;
        lifecycle_status: string;
        compliance_status: string;
        engagement_status: string;
        accepted_at: Date;
        cursor_at: string;
        updated_at: Date;
        reference_id: string | null;
        subject: string;
        category: string;
        service_name: string;
        sender_snapshot: {
            fromName?: string;
            fromEmail: string;
        };
        external_message_id: string | null;
        current_attempt_id: string | null;
    };
    const emailSelect = `SELECT d.id AS delivery_id,d.recipient_email,d.recipient_name,d.recipient_role,d.last_error,d.lifecycle_status,d.compliance_status,d.engagement_status,d.message_id,d.current_attempt_id,d.updated_at,m.accepted_at,to_char(m.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,m.reference_id,m.subject,m.message_category AS category,m.sender_snapshot,s.name AS service_name,da.external_message_id FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN services s ON s.id=m.service_id LEFT JOIN submission_attempts da ON da.id=d.current_attempt_id`;
    function mapEmail(row: EmailRow): EmailRecord {
        return {
            id: row.delivery_id, messageId: row.message_id, recipient: row.recipient_email,
            recipientName: row.recipient_name ?? undefined, recipientRole: row.recipient_role, lastError: row.last_error, subject: row.subject, category: row.category,
            service: row.service_name, from: row.sender_snapshot.fromName ? `${row.sender_snapshot.fromName} <${row.sender_snapshot.fromEmail}>` : row.sender_snapshot.fromEmail,
            status: (row.compliance_status === "suppressed" ? "suppressed" : row.lifecycle_status) as DeliveryStatus,
            createdAt: row.accepted_at.toISOString(), relativeTime: row.accepted_at.toISOString(),
            providerId: row.external_message_id ?? undefined, referenceId: row.reference_id ?? undefined
        };
    }
    async function listEmailPage(filters: MessageFilters, limit = 20) {
        const values: unknown[] = [];
        const conditions: string[] = [];
        const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
        if (filters.q) {
            const key = bind(`%${filters.q.replace(/[\\%_]/g, "\\$&")}%`);
            conditions.push(`(d.id ILIKE ${key} OR m.id ILIKE ${key} OR m.reference_id ILIKE ${key} OR d.recipient_email ILIKE ${key} OR m.subject ILIKE ${key} OR s.name ILIKE ${key})`);
        }
        if (filters.status === "suppressed")
            conditions.push("d.compliance_status='suppressed'");
        else if (filters.status !== "all")
            conditions.push(`d.lifecycle_status=${bind(filters.status)} AND d.compliance_status<>'suppressed'`);
        if (filters.cursor) {
            try {
                const cursor = JSON.parse(Buffer.from(filters.cursor, "base64url").toString("utf8"));
                if (typeof cursor.at === "string" && Number.isFinite(Date.parse(cursor.at)) && typeof cursor.id === "string") {
                    conditions.push(`(m.accepted_at,d.id)<(${bind(cursor.at)}::timestamptz,${bind(cursor.id)})`);
                }
            }
            catch { /* An invalid bookmark starts at the first page. */ }
        }
        const pageSize = Math.max(1, Math.min(10000, limit));
        const result = await query<EmailRow>(`${emailSelect} ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY m.accepted_at DESC,d.id DESC LIMIT ${bind(pageSize + 1)}`, values);
        const selected = result.rows.slice(0, pageSize);
        const last = selected.at(-1);
        return {
            records: selected.map(mapEmail),
            nextCursor: result.rows.length > pageSize && last ? Buffer.from(JSON.stringify({ at: last.cursor_at, id: last.delivery_id })).toString("base64url") : null
        };
    }
    async function listEmails(limit = 200) {
        return (await listEmailPage({ q: "", status: "all" }, limit)).records;
    }
    async function getDeliveryDetail(id: string):Promise<DeliveryDetailDto|null> {
        const row = (await query<EmailRow>(`${emailSelect} WHERE d.id=$1`, [id])).rows[0];
        if (!row)
            return null;
        const [attempts, events, content, eligibility] = await Promise.all([
            query<DeliveryAttemptDto>(`SELECT da.id,da.submission_id,da.attempt_number,da.status,da.outcome_determinate,da.external_message_id,da.rfc_message_id,da.error_category,da.error_code,da.error_message,da.diagnostic,da.routing_snapshot,da.started_at,da.finished_at,da.retry_authorized_at,da.retry_authorized_by,da.reconciliation_count,da.reconcile_after,pa.name AS provider_account,pa.type AS provider_type FROM submission_attempts da JOIN submission_deliveries sd ON sd.submission_id=da.submission_id JOIN provider_accounts pa ON pa.id=da.provider_account_id WHERE sd.delivery_id=$1 ORDER BY da.attempt_number DESC`, [id]),
            query<DeliveryEventDto>(`SELECT id,event_type,occurred_at,canonical_payload,scope FROM (
      SELECT id,event_type,occurred_at,canonical_payload,'recipient' AS scope FROM delivery_events WHERE delivery_id=$1
      UNION ALL SELECT e.id,e.event_type,e.occurred_at,e.canonical_payload,'submission' AS scope FROM submission_events e JOIN submission_deliveries sd ON sd.submission_id=e.submission_id WHERE sd.delivery_id=$1
    ) events ORDER BY occurred_at DESC,id DESC`, [id]),
            query<MessageContentDto>(`SELECT content_policy,html_body,text_body,reply_to,to_recipients,cc_recipients,bcc_recipients,attachment_snapshot,headers,in_reply_to,references_ids,sender_snapshot,content_purged_at FROM messages WHERE id=$1`, [row.message_id]),
            getRetryEligibility(id)
        ]);
        const stored=content.rows[0];
        if(!stored)return null;
        const safeContent:MessageContentDto={
          content_policy:stored.content_policy,html_body:stored.html_body,text_body:stored.text_body,
          reply_to:stored.reply_to,to_recipients:stored.to_recipients,cc_recipients:stored.cc_recipients,bcc_recipients:stored.bcc_recipients,
          attachment_snapshot:stored.attachment_snapshot.map(file=>({fileId:file.fileId,fileName:file.fileName,contentType:file.contentType,size:file.size,disposition:file.disposition,contentId:file.contentId})),
          headers:stored.headers,in_reply_to:stored.in_reply_to,references_ids:stored.references_ids,content_purged_at:stored.content_purged_at,
        };
        return {
            ...mapEmail(row), lifecycle: row.lifecycle_status, engagement: row.engagement_status,
            compliance: row.compliance_status, updatedAt: row.updated_at.toISOString(),
            attempts: attempts.rows, events: events.rows,
            content:safeContent, retry: eligibility
        };
    }
    return { listEmailPage, listEmails, getDeliveryDetail };
}
