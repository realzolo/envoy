import { diagnosticSchema } from "@/lib/contracts";
import { query, transaction } from "@/server/database";
import { objectStore } from "@/modules/config/object-store";
import { createId } from "@/server/ids";
import { encodeCursor } from "@/modules/core/message/service";

type Cursor = { at: Date | string; id: string } | null | undefined;

function nextCursor<T extends { id: string; cursor_at?: string }>(rows: T[], limit: number, date: (row: T) => Date) {
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
  }>(
    `SELECT d.id,d.message_id,d.recipient_email,d.recipient_name,d.recipient_role,d.last_error,d.lifecycle_status,d.engagement_status,
       d.compliance_status,d.queued_at,to_char(d.queued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,d.updated_at,m.subject,m.message_category AS category
     FROM deliveries d JOIN messages m ON m.id=d.message_id
     WHERE m.service_id=$1 AND ($2::text IS NULL OR d.message_id=$2)
       AND ($3::text IS NULL OR d.lifecycle_status=$3)
       AND ($4::timestamptz IS NULL OR (d.queued_at,d.id)<($4,$5))
     ORDER BY d.queued_at DESC,d.id DESC LIMIT $6`,
    [serviceId, options.messageId ?? null, options.status ?? null, options.cursor?.at ?? null, options.cursor?.id ?? null, options.limit + 1],
  )).rows;
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
  }>(
    `SELECT d.id,d.message_id,d.recipient_email,d.recipient_name,d.recipient_role,d.last_error,d.lifecycle_status,d.engagement_status,
       d.compliance_status,d.queued_at,d.accepted_at,d.delivered_at,d.updated_at,m.subject,
       m.message_category AS category,m.reference_id
     FROM deliveries d JOIN messages m ON m.id=d.message_id
     WHERE d.id=$1 AND m.service_id=$2`,
    [id, serviceId],
  )).rows[0];
  if (!delivery) return null;
  const [attempts, events] = await Promise.all([
    query(
      `SELECT sa.*,to_char(sa.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,json_agg(json_build_object('deliveryId',d.id,'email',d.recipient_email,'role',d.recipient_role) ORDER BY d.id) AS recipients
       FROM submission_attempts sa JOIN submission_deliveries sd ON sd.submission_id=sa.submission_id
       JOIN deliveries d ON d.id=sd.delivery_id
       WHERE sa.submission_id IN (SELECT submission_id FROM submission_deliveries WHERE delivery_id=$1)
       GROUP BY sa.id ORDER BY sa.started_at DESC,sa.id DESC`, [id],
    ),
    query<Omit<PublicEventRow, "delivery_id" | "message_id">>(
      "SELECT id,event_type,occurred_at,canonical_payload FROM delivery_events WHERE delivery_id=$1 ORDER BY occurred_at DESC,id DESC",
      [id],
    ),
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
  const rows = (await query<PublicEventRow>(
    `WITH events AS (
      SELECT de.id,de.delivery_id,NULL::text AS submission_id,d.message_id,de.event_type,de.occurred_at,de.canonical_payload
      FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id JOIN messages m ON m.id=d.message_id WHERE m.service_id=$1
      UNION ALL
      SELECT se.id,NULL::text AS delivery_id,se.submission_id,s.message_id,se.event_type,se.occurred_at,se.canonical_payload
      FROM submission_events se JOIN submissions s ON s.id=se.submission_id JOIN messages m ON m.id=s.message_id WHERE m.service_id=$1
    ) SELECT *,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM events
    WHERE ($2::text IS NULL OR delivery_id=$2) AND ($3::text IS NULL OR event_type=$3)
      AND ($7::text IS NULL OR message_id=$7) AND ($4::timestamptz IS NULL OR (occurred_at,id)<($4,$5))
    ORDER BY occurred_at DESC,id DESC LIMIT $6`,
    [serviceId, options.deliveryId ?? null, options.type ?? null, options.cursor?.at ?? null, options.cursor?.id ?? null, options.limit + 1, options.messageId ?? null],
  )).rows;
  const page = nextCursor(rows, options.limit, row => row.occurred_at);
  return {
    data: page.data.map(publicEvent),
    nextCursor: page.nextCursor,
  };
}

export async function listInboundMessages(serviceId: string, options: { limit: number; cursor?: Cursor }) {
  const rows = (await query<{
    id: string;
    from_email: string;
    to_emails: string[];
    subject: string;
    status: string;
    received_at: Date;
    author_date: Date | null; ingress_received_at: Date | null; ready_at: Date | null;
    attachment_count: string;
  }>(
    `SELECT i.id,i.from_email,i.to_emails,i.subject,i.status,i.created_at AS received_at,i.author_date,i.ingress_received_at,i.ready_at,to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,count(a.id)::text AS attachment_count
     FROM inbound_messages i LEFT JOIN inbound_attachments a ON a.inbound_message_id=i.id
     WHERE i.service_id=$1 AND ($2::timestamptz IS NULL OR (i.created_at,i.id)<($2,$3))
     GROUP BY i.id ORDER BY i.created_at DESC,i.id DESC LIMIT $4`,
    [serviceId, options.cursor?.at ?? null, options.cursor?.id ?? null, options.limit + 1],
  )).rows;
  const page = nextCursor(rows, options.limit, row => row.received_at);
  return {
    data: page.data.map(row => ({
      id: row.id,
      from: row.from_email,
      to: row.to_emails,
      subject: row.subject,
      status: row.status,
      attachmentCount: Number(row.attachment_count),
      receivedAt: row.received_at.toISOString(),
      authorDate: row.author_date?.toISOString() ?? null,
      ingressReceivedAt: row.ingress_received_at?.toISOString() ?? null,
      readyAt: row.ready_at?.toISOString() ?? null,
    })),
    nextCursor: page.nextCursor,
  };
}

export async function getInboundMessage(id: string, serviceId: string) {
  const message = (await query<{
    id: string;
    external_message_id: string | null;
    message_id: string | null;
    envelope_recipients: string[]; reply_to: string[]; in_reply_to: string | null; references_ids: string[];
    from_email: string;
    to_emails: string[];
    cc_emails: string[];
    bcc_emails: string[];
    subject: string;
    sanitized_html: string | null;
    text_body: string | null;
    content_purged_at: Date | null;
    status: string;
    rejection_reason: string | null;
    received_at: Date;
    author_date: Date | null; ingress_received_at: Date | null; ready_at: Date | null;
  }>("SELECT id,external_message_id,message_id,envelope_recipients,reply_to,in_reply_to,references_ids,from_email,to_emails,cc_emails,bcc_emails,subject,sanitized_html,text_body,content_purged_at,status,rejection_reason,created_at AS received_at,author_date,ingress_received_at,ready_at FROM inbound_messages WHERE id=$1 AND service_id=$2", [id, serviceId])).rows[0];
  if (!message) return null;
  const attachments = (await query<{
    id: string;
    file_name: string;
    content_type: string;
    size_bytes: string;
    content_id: string | null;
    scan_status: string;
    content_purged_at: Date | null;
  }>("SELECT id,file_name,content_type,size_bytes::text,content_id,scan_status,content_purged_at FROM inbound_attachments WHERE inbound_message_id=$1 ORDER BY created_at,id", [id])).rows;
  return {
    id: message.id,
    messageId: message.message_id ?? null,
    envelopeRecipients: message.envelope_recipients ?? [],
    replyTo: message.reply_to ?? [],
    inReplyTo: message.in_reply_to ?? null,
    references: message.references_ids ?? [],
    from: message.from_email,
    to: message.to_emails,
    cc: message.cc_emails,
    bcc: message.bcc_emails,
    subject: message.subject,
    html: message.sanitized_html,
    text: message.text_body,
    contentPurgedAt: message.content_purged_at?.toISOString() ?? null,
    status: message.status,
    rejectionReason: message.rejection_reason,
    receivedAt: message.received_at.toISOString(),
    authorDate: message.author_date?.toISOString() ?? null,
    ingressReceivedAt: message.ingress_received_at?.toISOString() ?? null,
    readyAt: message.ready_at?.toISOString() ?? null,
    attachments: attachments.map(item => ({
      id: item.id,
      fileName: item.file_name,
      contentType: item.content_type,
      size: Number(item.size_bytes),
      contentId: item.content_id,
      scanStatus: item.scan_status,
      contentAvailable: item.content_purged_at === null,
    })),
  };
}

export async function listSuppressions(productId: string, email?: string | null) {
  const rows = (await query<{
    id: string;
    scope_type: string;
    list_id: string | null;
    email_normalized: string;
    reason: string;
    source: string;
    expires_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id,scope_type,list_id,email_normalized,reason,source,expires_at,created_at FROM suppressions
     WHERE active=true AND (expires_at IS NULL OR expires_at>now())
       AND (($2::text IS NOT NULL AND email_normalized=lower($2) AND (scope_type='global' OR product_id=$1))
         OR ($2::text IS NULL AND product_id=$1))
     ORDER BY created_at DESC`,
    [productId, email ?? null],
  )).rows;
  return rows.map(row => ({
    id: row.id,
    scope: row.scope_type,
    listId: row.list_id,
    email: row.email_normalized,
    reason: row.reason,
    source: row.source,
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function createSuppression(input: {
  productId: string;
  email: string;
  scope: "product" | "list";
  listId?: string;
  reason: string;
  expiresAt?: string;
}) {
  return transaction(async client => {
    const email = input.email.toLowerCase();
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(["suppression", input.productId, input.scope, input.listId ?? null, email])]);
    const existing = (await client.query<{ id: string }>(
      `SELECT id FROM suppressions WHERE active=true AND product_id=$1 AND scope_type=$2
       AND COALESCE(list_id,'')=COALESCE($3,'') AND email_normalized=$4 FOR UPDATE`,
      [input.productId, input.scope, input.listId ?? null, email],
    )).rows[0];
    if (existing) return { id: existing.id, duplicate: true };
    const id = createId("sup");
    await client.query(
      `INSERT INTO suppressions(id,scope_type,product_id,list_id,email_normalized,reason,source,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'service_api',$7)`,
      [id, input.scope, input.productId, input.listId ?? null, email, input.reason, input.expiresAt ?? null],
    );
    return { id, duplicate: false };
  });
}

export async function removeSuppression(id: string, productId: string) {
  const result = await query<{ id: string }>(
    "UPDATE suppressions SET active=false,updated_at=now() WHERE id=$1 AND product_id=$2 AND active=true RETURNING id",
    [id, productId],
  );
  return result.rows[0] ?? null;
}

export async function listSenderProfiles(productId: string) {
  const rows = (await query<{
    id: string;
    name: string;
    from_name: string;
    from_local_part: string;
    reply_to: string | null;
    message_category: string;
    domain: string;
    provider_count: string;
  }>(
    `SELECT sp.id,sp.name,sp.from_name,sp.from_local_part,sp.reply_to,sp.message_category,sd.domain,
       count(pi.id) FILTER (WHERE pi.status='verified' AND pa.status='active')::text AS provider_count
     FROM sender_profiles sp JOIN sending_domains sd ON sd.id=sp.sending_domain_id
     LEFT JOIN provider_identities pi ON pi.sending_domain_id=sd.id
     LEFT JOIN provider_accounts pa ON pa.id=pi.provider_account_id
     WHERE sp.product_id=$1 AND sp.status='active' AND sd.status='active'
     GROUP BY sp.id,sd.domain ORDER BY sp.message_category,sp.name`,
    [productId],
  )).rows;
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    category: row.message_category,
    from: { name: row.from_name, email: `${row.from_local_part}@${row.domain}` },
    replyTo: row.reply_to,
    availableProviders: Number(row.provider_count),
  }));
}


type PublicEventRow = { id: string; message_id: string; delivery_id: string | null; submission_id?: string; event_type: string; occurred_at: Date; canonical_payload: Record<string, unknown> };
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

export async function getMessageAttempts(messageId: string, serviceId: string, options: { limit: number; cursor?: Cursor }) {
  const owned = await query("SELECT id FROM messages WHERE id=$1 AND service_id=$2", [messageId,serviceId]);
  if (!owned.rowCount) return null;
  const attempts = await query(`SELECT sa.*,to_char(sa.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,json_agg(json_build_object('deliveryId',d.id,'email',d.recipient_email,'role',d.recipient_role) ORDER BY d.id) AS recipients
    FROM submission_attempts sa JOIN submissions s ON s.id=sa.submission_id
    JOIN submission_deliveries sd ON sd.submission_id=s.id JOIN deliveries d ON d.id=sd.delivery_id
    WHERE s.message_id=$1 AND ($2::timestamptz IS NULL OR (sa.started_at,sa.id)<($2,$3))
    GROUP BY sa.id ORDER BY sa.started_at DESC,sa.id DESC LIMIT $4`, [messageId,options.cursor?.at ?? null,options.cursor?.id ?? null,options.limit+1]);
  const page = nextCursor(attempts.rows as ({ id: string; started_at: Date } & Record<string, unknown>)[], options.limit, row => row.started_at);
  return { data: page.data.map(publicAttempt), nextCursor: page.nextCursor };
}

export async function getMessageEvents(messageId: string, serviceId: string, options: { limit: number; cursor?: Cursor }) {
  const owned = await query("SELECT id FROM messages WHERE id=$1 AND service_id=$2", [messageId,serviceId]);
  if (!owned.rowCount) return null;
  return listEvents(serviceId, { ...options, messageId });
}

export async function getRequestDiagnostic(requestId: string, serviceId: string) {
  const row = (await query<{ request_id: string; method: string; path: string; status_code: number; duration_ms: number; message_id: string | null; created_at: Date; details: Record<string, unknown> }>(
    "SELECT request_id,method,path,status_code,duration_ms,message_id,created_at,details FROM request_logs WHERE request_id=$1 AND service_id=$2", [requestId,serviceId],
  )).rows[0];
  return row ? { requestId: row.request_id, method: row.method, path: row.path, statusCode: row.status_code, durationMs: row.duration_ms, messageId: row.message_id, createdAt: row.created_at.toISOString(), problem: row.details.problem ?? null } : null;
}

// serviceId is mandatory for service callers; administrators call without it
// only after their own session authorization. Object keys never leave the server.
export async function getInboundAttachment(id: string, attachmentId: string, serviceId?: string) {
  const file = (await query<{ file_name: string; content_type: string; object_key: string; size_bytes: string; scan_status: string }>(
    `SELECT a.file_name,a.content_type,a.object_key,a.size_bytes::text,a.scan_status
     FROM inbound_attachments a JOIN inbound_messages i ON i.id=a.inbound_message_id
     WHERE i.id=$1 AND a.id=$2 AND a.content_purged_at IS NULL AND i.status='ready' AND ($3::text IS NULL OR i.service_id=$3)
       AND (a.scan_status='clean' OR (a.scan_status='skipped' AND $4::boolean))`,
    [id, attachmentId, serviceId ?? null, !process.env.CLAMAV_HOST?.trim()],
  )).rows[0];
  if (!file) return null;
  const bytes = await objectStore().get(file.object_key);
  const filename = file.file_name.replace(/[\\"\r\n\x00-\x1f]/g, "_");
  return new Response(Buffer.from(bytes), { headers: {
    "content-type": "application/octet-stream",
    "content-length": String(bytes.byteLength),
    "content-disposition": `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    "x-content-type-options": "nosniff", "cache-control": "private, no-store",
    "content-security-policy": "sandbox",
  } });
}
