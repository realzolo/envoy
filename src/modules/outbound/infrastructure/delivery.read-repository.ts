import { diagnosticSchema } from "@/lib/contracts";
import { encodeCursor } from "@/lib/pagination";
import { outboundDomainAccess } from "@/modules/identity/infrastructure/authorization";
import { query } from "@/platform/database";
type Cursor = {
    at: Date | string;
    id: string;
} | null | undefined;
function nextCursor<T extends {
    id: string;
    cursor_at?: string;
}>(rows: T[], limit: number, date: (row: T) => Date) {
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    return {
        data,
        nextCursor: hasMore ? encodeCursor({
            id: data[data.length - 1].id,
            cursor_at: data[data.length - 1].cursor_at,
            accepted_at: date(data[data.length - 1])
        }) : null,
    };
}
export async function listDeliveries(serviceId: string, options: {
    limit: number;
    cursor?: Cursor;
    messageId?: string | null;
    status?: string | null;
}) {
    const rows = (await query<{
        id: string;
        message_id: string;
        recipient_email: string;
        recipient_name: string | null;
        recipient_role: "to" | "cc" | "bcc";
        last_error: Record<string, unknown> | null;
        lifecycle_status: string;
        engagement_status: string;
        compliance_status: string;
        queued_at: Date;
        updated_at: Date;
        subject: string;
        category: string;
    }>(`SELECT d.id,d.message_id,d.recipient_email,d.recipient_name,d.recipient_role,d.last_error,d.lifecycle_status,d.engagement_status,
       d.compliance_status,d.queued_at,to_char(d.queued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,d.updated_at,m.subject,m.message_category AS category
     FROM deliveries d JOIN messages m ON m.id=d.message_id
     WHERE m.service_id=$1 AND ${outboundDomainAccess('m')} AND ($2::text IS NULL OR d.message_id=$2)
       AND ($3::text IS NULL OR d.lifecycle_status=$3)
       AND ($4::timestamptz IS NULL OR (d.queued_at,d.id)<($4,$5))
     ORDER BY d.queued_at DESC,d.id DESC LIMIT $6`, [serviceId, options.messageId ?? null, options.status ?? null, options.cursor?.at ?? null, options.cursor?.id ?? null, options.limit + 1])).rows;
    const page = nextCursor(rows, options.limit, row => row.queued_at);
    return {
        data: page.data.map(row => ({
            id: row.id,
            messageId: row.message_id,
            recipient: row.recipient_email,
            recipientName: row.recipient_name,
            recipientRole: row.recipient_role,
            lastError: publicDiagnostic(row.last_error),
            subject: row.subject,
            category: row.category,
            lifecycle: row.lifecycle_status,
            engagement: row.engagement_status,
            compliance: row.compliance_status,
            queuedAt: row.queued_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
        })),
        nextCursor: page.nextCursor,
    };
}
export async function getDelivery(id: string, serviceId: string) {
    const delivery = (await query<{
        id: string;
        message_id: string;
        recipient_email: string;
        recipient_name: string | null;
        recipient_role: "to" | "cc" | "bcc";
        last_error: Record<string, unknown> | null;
        lifecycle_status: string;
        engagement_status: string;
        compliance_status: string;
        queued_at: Date;
        accepted_at: Date | null;
        delivered_at: Date | null;
        updated_at: Date;
        subject: string;
        category: string;
        reference_id: string | null;
    }>(`SELECT d.id,d.message_id,d.recipient_email,d.recipient_name,d.recipient_role,d.last_error,d.lifecycle_status,d.engagement_status,
       d.compliance_status,d.queued_at,d.accepted_at,d.delivered_at,d.updated_at,m.subject,
       m.message_category AS category,m.reference_id
     FROM deliveries d JOIN messages m ON m.id=d.message_id
     WHERE d.id=$1 AND m.service_id=$2 AND ${outboundDomainAccess('m')}`, [id, serviceId])).rows[0];
    if (!delivery)
        return null;
    const [attempts, events] = await Promise.all([
        query(`SELECT sa.*,to_char(sa.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,json_agg(json_build_object('deliveryId',d.id,'email',d.recipient_email,'role',d.recipient_role) ORDER BY d.id) AS recipients
       FROM submission_attempts sa JOIN submission_deliveries sd ON sd.submission_id=sa.submission_id
       JOIN deliveries d ON d.id=sd.delivery_id
       WHERE sa.submission_id IN (SELECT submission_id FROM submission_deliveries WHERE delivery_id=$1)
       GROUP BY sa.id ORDER BY sa.started_at DESC,sa.id DESC`, [id]),
        query<Omit<PublicEventRow, "delivery_id" | "message_id">>("SELECT id,event_type,occurred_at,canonical_payload FROM delivery_events WHERE delivery_id=$1 ORDER BY occurred_at DESC,id DESC", [id]),
    ]);
    return {
        id: delivery.id,
        messageId: delivery.message_id,
        referenceId: delivery.reference_id,
        recipient: delivery.recipient_email,
        recipientName: delivery.recipient_name,
        recipientRole: delivery.recipient_role,
        lastError: publicDiagnostic(delivery.last_error),
        subject: delivery.subject,
        category: delivery.category,
        lifecycle: delivery.lifecycle_status,
        engagement: delivery.engagement_status,
        compliance: delivery.compliance_status,
        queuedAt: delivery.queued_at.toISOString(),
        acceptedAt: delivery.accepted_at?.toISOString() ?? null,
        deliveredAt: delivery.delivered_at?.toISOString() ?? null,
        updatedAt: delivery.updated_at.toISOString(),
        attempts: attempts.rows.map(publicAttempt),
        events: events.rows.map(row => publicEvent({ ...row, delivery_id: delivery.id, message_id: delivery.message_id })),
    };
}
export async function listEvents(serviceId: string, options: {
    limit: number;
    cursor?: Cursor;
    deliveryId?: string | null;
    messageId?: string | null;
    type?: string | null;
}) {
    const rows = (await query<PublicEventRow>(`WITH events AS (
      SELECT de.id,de.delivery_id,NULL::text AS submission_id,d.message_id,de.event_type,de.occurred_at,de.canonical_payload
      FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id JOIN messages m ON m.id=d.message_id WHERE m.service_id=$1 AND ${outboundDomainAccess('m')}
      UNION ALL
      SELECT se.id,NULL::text AS delivery_id,se.submission_id,s.message_id,se.event_type,se.occurred_at,se.canonical_payload
      FROM submission_events se JOIN submissions s ON s.id=se.submission_id JOIN messages m ON m.id=s.message_id WHERE m.service_id=$1 AND ${outboundDomainAccess('m')}
    ) SELECT *,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM events
    WHERE ($2::text IS NULL OR delivery_id=$2) AND ($3::text IS NULL OR event_type=$3)
      AND ($7::text IS NULL OR message_id=$7) AND ($4::timestamptz IS NULL OR (occurred_at,id)<($4,$5))
    ORDER BY occurred_at DESC,id DESC LIMIT $6`, [serviceId, options.deliveryId ?? null, options.type ?? null, options.cursor?.at ?? null, options.cursor?.id ?? null, options.limit + 1, options.messageId ?? null])).rows;
    const page = nextCursor(rows, options.limit, row => row.occurred_at);
    return {
        data: page.data.map(publicEvent),
        nextCursor: page.nextCursor,
    };
}
type PublicEventRow = {
    id: string;
    message_id: string;
    delivery_id: string | null;
    submission_id?: string;
    event_type: string;
    occurred_at: Date;
    canonical_payload: Record<string, unknown>;
};
export function publicEvent(row: PublicEventRow) {
    const payload = row.canonical_payload;
    const bounce = payload.bounce && typeof payload.bounce === "object" ? payload.bounce as Record<string, unknown> : null;
    const diagnostic = payload.diagnostic ?? (payload.metadata && typeof payload.metadata === "object" ? (payload.metadata as Record<string, unknown>).diagnostic : undefined);
    return {
        id: row.id, messageId: row.message_id, deliveryId: row.delivery_id,
        ...(row.submission_id ? { submissionId: row.submission_id } : {}),
        scope: row.delivery_id ? "recipient" : "submission",
        type: row.event_type, occurredAt: row.occurred_at.toISOString(),
        data: {
            ...(typeof payload.attemptId === "string" ? { attemptId: payload.attemptId } : {}),
            ...(typeof payload.recipient === "string" ? { recipient: payload.recipient } : {}),
            ...(publicDiagnostic(diagnostic) ? { diagnostic: publicDiagnostic(diagnostic) } : {}),
            ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
            ...(bounce && (bounce.classification === "hard" || bounce.classification === "soft") ? { bounce: {
                    classification: bounce.classification,
                    ...(typeof bounce.code === "string" ? { code: bounce.code } : {}),
                    ...(typeof bounce.message === "string" ? { message: bounce.message } : {}),
                } } : {}),
        },
    };
}
function publicDiagnostic(value: unknown) {
    const parsed = diagnosticSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
function publicAttempt(row: Record<string, unknown>) {
    return {
        id: row.id, submissionId: row.submission_id, number: row.attempt_number, status: row.status,
        rfcMessageId: row.rfc_message_id ?? null,
        rfcMessageIdStatus: row.rfc_message_id ? "confirmed" : "unknown",
        outcomeDeterminate: row.outcome_determinate, error: publicDiagnostic(row.diagnostic),
        startedAt: (row.started_at as Date).toISOString(), finishedAt: (row.finished_at as Date | null)?.toISOString() ?? null,
        recipients: row.recipients ?? [],
    };
}
export async function getMessageAttempts(messageId: string, serviceId: string, options: {
    limit: number;
    cursor?: Cursor;
}) {
    const owned = await query(`SELECT id FROM messages m WHERE id=$1 AND service_id=$2 AND ${outboundDomainAccess('m')}`, [messageId, serviceId]);
    if (!owned.rowCount)
        return null;
    const attempts = await query(`SELECT sa.*,to_char(sa.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,json_agg(json_build_object('deliveryId',d.id,'email',d.recipient_email,'role',d.recipient_role) ORDER BY d.id) AS recipients
    FROM submission_attempts sa JOIN submissions s ON s.id=sa.submission_id
    JOIN submission_deliveries sd ON sd.submission_id=s.id JOIN deliveries d ON d.id=sd.delivery_id
    WHERE s.message_id=$1 AND ($2::timestamptz IS NULL OR (sa.started_at,sa.id)<($2,$3))
    GROUP BY sa.id ORDER BY sa.started_at DESC,sa.id DESC LIMIT $4`, [messageId, options.cursor?.at ?? null, options.cursor?.id ?? null, options.limit + 1]);
    const page = nextCursor(attempts.rows as ({
        id: string;
        started_at: Date;
    } & Record<string, unknown>)[], options.limit, row => row.started_at);
    return { data: page.data.map(publicAttempt), nextCursor: page.nextCursor };
}
export async function getMessageEvents(messageId: string, serviceId: string, options: {
    limit: number;
    cursor?: Cursor;
}) {
    const owned = await query(`SELECT id FROM messages m WHERE id=$1 AND service_id=$2 AND ${outboundDomainAccess('m')}`, [messageId, serviceId]);
    if (!owned.rowCount)
        return null;
    return listEvents(serviceId, { ...options, messageId });
}
export async function getRequestDiagnostic(requestId: string, serviceId: string) {
    const row = (await query<{
        request_id: string;
        method: string;
        path: string;
        status_code: number;
        duration_ms: number;
        message_id: string | null;
        created_at: Date;
        details: Record<string, unknown>;
    }>(`SELECT request_id,method,path,status_code,duration_ms,message_id,created_at,details FROM request_logs r WHERE request_id=$1 AND service_id=$2 AND (message_id IS NULL OR EXISTS(SELECT 1 FROM messages m WHERE m.id=r.message_id AND ${outboundDomainAccess('m')}))`, [requestId, serviceId])).rows[0];
    return row ? { requestId: row.request_id, method: row.method, path: row.path, statusCode: row.status_code, durationMs: row.duration_ms, messageId: row.message_id, createdAt: row.created_at.toISOString(), problem: row.details.problem ?? null } : null;
}
