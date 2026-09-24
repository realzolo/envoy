import { query, transaction } from "@/server/database";
import { createId } from "@/server/ids";
import { encodeCursor } from "@/modules/core/message/service";

type Cursor = { at: Date; id: string } | null | undefined;

function nextCursor<T extends { id: string }>(rows: T[], limit: number, date: (row: T) => Date) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    nextCursor: hasMore ? encodeCursor({
      id: data[data.length - 1].id,
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
    lifecycle_status: string;
    engagement_status: string;
    compliance_status: string;
    queued_at: Date;
    updated_at: Date;
    subject: string;
    category: string;
  }>(
    `SELECT d.id,d.message_id,d.recipient_email,d.recipient_name,d.lifecycle_status,d.engagement_status,
       d.compliance_status,d.queued_at,d.updated_at,m.subject,m.message_category AS category
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
    `SELECT d.id,d.message_id,d.recipient_email,d.recipient_name,d.lifecycle_status,d.engagement_status,
       d.compliance_status,d.queued_at,d.accepted_at,d.delivered_at,d.updated_at,m.subject,
       m.message_category AS category,m.reference_id
     FROM deliveries d JOIN messages m ON m.id=d.message_id
     WHERE d.id=$1 AND m.service_id=$2`,
    [id, serviceId],
  )).rows[0];
  if (!delivery) return null;
  const [attempts, events] = await Promise.all([
    query(
      `SELECT da.id,da.attempt_number,pa.type AS provider,pa.name AS provider_account,da.status,
         da.outcome_determinate,da.external_message_id,da.error_category,da.error_code,da.error_message,
         da.started_at,da.finished_at
       FROM delivery_attempts da JOIN provider_accounts pa ON pa.id=da.provider_account_id
       WHERE da.delivery_id=$1 ORDER BY da.attempt_number DESC`,
      [id],
    ),
    query(
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
    subject: delivery.subject,
    category: delivery.category,
    lifecycle: delivery.lifecycle_status,
    engagement: delivery.engagement_status,
    compliance: delivery.compliance_status,
    queuedAt: delivery.queued_at.toISOString(),
    acceptedAt: delivery.accepted_at?.toISOString() ?? null,
    deliveredAt: delivery.delivered_at?.toISOString() ?? null,
    updatedAt: delivery.updated_at.toISOString(),
    attempts: attempts.rows,
    events: events.rows,
  };
}

export async function listEvents(serviceId: string, options: {
  limit: number;
  cursor?: Cursor;
  deliveryId?: string | null;
  type?: string | null;
}) {
  const rows = (await query<{
    id: string;
    delivery_id: string;
    message_id: string;
    event_type: string;
    occurred_at: Date;
    canonical_payload: Record<string, unknown>;
  }>(
    `SELECT de.id,de.delivery_id,d.message_id,de.event_type,de.occurred_at,de.canonical_payload
     FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id JOIN messages m ON m.id=d.message_id
     WHERE m.service_id=$1 AND ($2::text IS NULL OR de.delivery_id=$2)
       AND ($3::text IS NULL OR de.event_type=$3)
       AND ($4::timestamptz IS NULL OR (de.occurred_at,de.id)<($4,$5))
     ORDER BY de.occurred_at DESC,de.id DESC LIMIT $6`,
    [serviceId, options.deliveryId ?? null, options.type ?? null, options.cursor?.at ?? null, options.cursor?.id ?? null, options.limit + 1],
  )).rows;
  const page = nextCursor(rows, options.limit, row => row.occurred_at);
  return {
    data: page.data.map(row => ({
      id: row.id,
      messageId: row.message_id,
      deliveryId: row.delivery_id,
      type: row.event_type,
      occurredAt: row.occurred_at.toISOString(),
      data: row.canonical_payload,
    })),
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
    attachment_count: string;
  }>(
    `SELECT i.id,i.from_email,i.to_emails,i.subject,i.status,i.received_at,count(a.id)::text AS attachment_count
     FROM inbound_messages i LEFT JOIN inbound_attachments a ON a.inbound_message_id=i.id
     WHERE i.service_id=$1 AND ($2::timestamptz IS NULL OR (i.received_at,i.id)<($2,$3))
     GROUP BY i.id ORDER BY i.received_at DESC,i.id DESC LIMIT $4`,
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
    })),
    nextCursor: page.nextCursor,
  };
}

export async function getInboundMessage(id: string, serviceId: string) {
  const message = (await query<{
    id: string;
    external_message_id: string | null;
    message_id: string | null;
    from_email: string;
    to_emails: string[];
    cc_emails: string[];
    bcc_emails: string[];
    subject: string;
    sanitized_html: string | null;
    text_body: string | null;
    status: string;
    rejection_reason: string | null;
    received_at: Date;
  }>("SELECT id,external_message_id,message_id,from_email,to_emails,cc_emails,bcc_emails,subject,sanitized_html,text_body,status,rejection_reason,received_at FROM inbound_messages WHERE id=$1 AND service_id=$2", [id, serviceId])).rows[0];
  if (!message) return null;
  const attachments = (await query<{
    id: string;
    file_name: string;
    content_type: string;
    size_bytes: string;
    content_id: string | null;
    scan_status: string;
  }>("SELECT id,file_name,content_type,size_bytes::text,content_id,scan_status FROM inbound_attachments WHERE inbound_message_id=$1 ORDER BY created_at,id", [id])).rows;
  return {
    id: message.id,
    externalMessageId: message.external_message_id,
    messageId: message.message_id,
    from: message.from_email,
    to: message.to_emails,
    cc: message.cc_emails,
    bcc: message.bcc_emails,
    subject: message.subject,
    html: message.sanitized_html,
    text: message.text_body,
    status: message.status,
    rejectionReason: message.rejection_reason,
    receivedAt: message.received_at.toISOString(),
    attachments: attachments.map(item => ({
      id: item.id,
      fileName: item.file_name,
      contentType: item.content_type,
      size: Number(item.size_bytes),
      contentId: item.content_id,
      scanStatus: item.scan_status,
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
