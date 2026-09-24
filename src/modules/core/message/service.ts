import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { CreateMessageInput } from "@/lib/contracts";
import type { ServiceIdentity } from "@/server/auth";
import { query, transaction } from "@/server/database";
import { createId } from "@/server/ids";

export class MessageValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super("Message validation failed");
  }
}

export class IdempotencyConflictError extends Error {
}

export class DuplicateRiskError extends Error {
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

function hashPayload(input: CreateMessageInput) {
  return createHash("sha256").update(JSON.stringify(stable(input))).digest("hex");
}

export function encodeCursor(row: { accepted_at: Date; id: string }) {
  return Buffer.from(JSON.stringify({ at: row.accepted_at.toISOString(), id: row.id })).toString("base64url");
}

export function decodeCursor(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { at?: string; id?: string };
    const at = new Date(parsed.at ?? "");
    if (!parsed.id || Number.isNaN(at.getTime())) return null;
    return { at, id: parsed.id };
  } catch {
    return null;
  }
}

async function suppression(client: PoolClient, productId: string, email: string, listId?: string) {
  return Boolean((await client.query(
    `SELECT 1 FROM suppressions
     WHERE active=true AND email_normalized=$1 AND (expires_at IS NULL OR expires_at>now())
       AND (scope_type='global' OR (scope_type='product' AND product_id=$2)
         OR (scope_type='list' AND product_id=$2 AND list_id=$3)) LIMIT 1`,
    [email.toLowerCase(), productId, listId ?? null],
  )).rowCount);
}

export async function acceptMessage(args: {
  identity: ServiceIdentity;
  idempotencyKey: string;
  input: CreateMessageInput
}) {
  const payloadHash = hashPayload(args.input);
  return transaction(async client => {
    const existing = await client.query<{ id: string; payload_hash: string; accepted_at: Date }>(
      "SELECT id,payload_hash,accepted_at FROM messages WHERE service_id=$1 AND idempotency_key=$2 FOR UPDATE",
      [args.identity.serviceId, args.idempotencyKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].payload_hash !== payloadHash) throw new IdempotencyConflictError();
      return {
        duplicate: true,
        message: {
          id: existing.rows[0].id,
          status: "queued" as const,
          product: args.identity.product,
          category: args.input.category,
          recipientCount: args.input.to.length,
          acceptedAt: existing.rows[0].accepted_at.toISOString(),
          referenceId: args.input.referenceId,
        },
      };
    }

    const sender = (await client.query<{ id: string; reply_to: string | null }>(
      `SELECT sp.id,sp.reply_to FROM sender_profiles sp
       JOIN sending_domains sd ON sd.id=sp.sending_domain_id AND sd.status='active'
       WHERE sp.product_id=$1 AND sp.message_category=$2 AND sp.status='active'
         AND ($3::text IS NULL OR sp.name=$3)
       ORDER BY sp.created_at,sp.id LIMIT 1`,
      [args.identity.productId, args.input.category, args.input.senderProfile ?? null],
    )).rows[0];
    if (!sender) {
      throw new MessageValidationError([
        args.input.senderProfile
          ? `Sender profile ${args.input.senderProfile} is unavailable for category ${args.input.category}.`
          : `No active sender profile is available for category ${args.input.category}.`,
      ]);
    }

    const id = createId("msg");
    await client.query(
      `INSERT INTO messages(
        id,product_id,service_id,sender_profile_id,idempotency_key,payload_hash,reference_id,metadata,
        recipient_count,subject,html_body,text_body,message_category,reply_to,provider_tags
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id,
        args.identity.productId,
        args.identity.serviceId,
        sender.id,
        args.idempotencyKey,
        payloadHash,
        args.input.referenceId ?? null,
        args.input.metadata ?? {},
        args.input.to.length,
        args.input.subject,
        args.input.html ?? null,
        args.input.text ?? null,
        args.input.category,
        args.input.replyTo ?? sender.reply_to,
        args.input.tags ?? {},
      ],
    );
    for (const recipient of args.input.to) {
      const deliveryId = createId("dlv");
      const blocked = await suppression(client, args.identity.productId, recipient.email, args.input.metadata?.listId);
      await client.query(
        `INSERT INTO deliveries(id,message_id,recipient_email,recipient_name,lifecycle_status,compliance_status)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [deliveryId, id, recipient.email.toLowerCase(), recipient.name ?? null, blocked ? "failed" : "queued", blocked ? "suppressed" : "clean"],
      );
      await client.query(
        "INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'delivery',$2,$3,$4)",
        [createId("out"), deliveryId, blocked ? "delivery.suppressed" : "delivery.requested", { deliveryId }],
      );
    }
    return {
      duplicate: false,
      message: {
        id,
        status: "queued" as const,
        product: args.identity.product,
        category: args.input.category,
        recipientCount: args.input.to.length,
        acceptedAt: new Date().toISOString(),
        referenceId: args.input.referenceId,
      },
    };
  });
}

const aggregateStatus = `CASE
  WHEN bool_and(d.lifecycle_status='canceled') THEN 'canceled'
  WHEN bool_and(d.lifecycle_status='delivered') THEN 'delivered'
  WHEN bool_or(d.lifecycle_status=ANY(ARRAY['queued','submitting','accepted','deferred','unknown'])) THEN 'in_progress'
  ELSE 'completed' END`;

type MessageRow = {
  id: string;
  product: string;
  category: string;
  subject: string;
  recipient_count: number;
  accepted_at: Date;
  reference_id: string | null;
  sender_profile: string;
  status: string;
};

export async function listMessages(serviceId: string, options: {
  limit: number;
  cursor?: { at: Date; id: string } | null;
  status?: string | null;
  referenceId?: string | null;
}) {
  const rows = (await query<MessageRow>(
    `WITH summaries AS (
       SELECT m.id,p.name AS product,m.message_category AS category,m.subject,m.recipient_count,m.accepted_at,
         m.reference_id,sp.name AS sender_profile,${aggregateStatus} AS status
       FROM messages m JOIN products p ON p.id=m.product_id
       JOIN sender_profiles sp ON sp.id=m.sender_profile_id
       JOIN deliveries d ON d.message_id=m.id
       WHERE m.service_id=$1
       GROUP BY m.id,p.name,sp.name
     ) SELECT * FROM summaries
     WHERE ($2::timestamptz IS NULL OR (accepted_at,id)<($2,$3))
       AND ($4::text IS NULL OR status=$4)
       AND ($5::text IS NULL OR reference_id=$5)
     ORDER BY accepted_at DESC,id DESC LIMIT $6`,
    [serviceId, options.cursor?.at ?? null, options.cursor?.id ?? null, options.status ?? null, options.referenceId ?? null, options.limit + 1],
  )).rows;
  const hasMore = rows.length > options.limit;
  const data = hasMore ? rows.slice(0, options.limit) : rows;
  return {
    data: data.map(row => ({
      id: row.id,
      status: row.status,
      product: row.product,
      category: row.category,
      senderProfile: row.sender_profile,
      subject: row.subject,
      recipientCount: row.recipient_count,
      acceptedAt: row.accepted_at.toISOString(),
      referenceId: row.reference_id,
    })),
    nextCursor: hasMore ? encodeCursor(data[data.length - 1]) : null,
  };
}

export async function getMessage(id: string, serviceId: string) {
  const message = (await query<MessageRow & {
    html_body: string | null;
    text_body: string | null;
    reply_to: string | null;
    metadata: Record<string, string>;
    provider_tags: Record<string, string>;
  }>(
    `SELECT m.id,p.name AS product,m.message_category AS category,m.subject,m.html_body,m.text_body,m.reply_to,
       m.metadata,m.provider_tags,m.recipient_count,m.accepted_at,m.reference_id,sp.name AS sender_profile,
       ${aggregateStatus} AS status
     FROM messages m JOIN products p ON p.id=m.product_id
     JOIN sender_profiles sp ON sp.id=m.sender_profile_id
     JOIN deliveries d ON d.message_id=m.id
     WHERE m.id=$1 AND m.service_id=$2
     GROUP BY m.id,p.name,sp.name`,
    [id, serviceId],
  )).rows[0];
  if (!message) return null;
  const deliveries = (await query<{
    id: string;
    recipient_email: string;
    recipient_name: string | null;
    lifecycle_status: string;
    engagement_status: string;
    compliance_status: string;
    updated_at: Date;
  }>(
    "SELECT id,recipient_email,recipient_name,lifecycle_status,engagement_status,compliance_status,updated_at FROM deliveries WHERE message_id=$1 ORDER BY queued_at,id",
    [id],
  )).rows;
  return { ...message, deliveries };
}

export async function cancelMessage(id: string, serviceId: string) {
  return transaction(async client => {
    const owned = await client.query("SELECT 1 FROM messages WHERE id=$1 AND service_id=$2 FOR UPDATE", [id, serviceId]);
    if (!owned.rowCount) return null;
    const canceled = await client.query<{ id: string }>(
      `UPDATE deliveries SET lifecycle_status='canceled',updated_at=now()
       WHERE message_id=$1 AND lifecycle_status IN ('queued','deferred','failed')
         AND compliance_status='clean'
         AND NOT EXISTS (
           SELECT 1 FROM delivery_attempts da WHERE da.delivery_id=deliveries.id
             AND (da.status IN ('accepted','reconciled','unknown','reconciling') OR da.outcome_determinate=false)
         ) RETURNING id`,
      [id],
    );
    for (const delivery of canceled.rows) {
      const eventId = createId("dev");
      await client.query(
        "INSERT INTO delivery_events(id,delivery_id,event_type,occurred_at,canonical_payload) VALUES ($1,$2,'canceled',now(),$3)",
        [eventId, delivery.id, { id: eventId, type: "canceled", source: "service_api" }],
      );
      await client.query(
        "UPDATE outbox_events SET status='published',published_at=COALESCE(published_at,now()) WHERE status='pending' AND event_type='delivery.requested' AND payload->>'deliveryId'=$1",
        [delivery.id],
      );
    }
    return { messageId: id, canceled: canceled.rowCount ?? 0 };
  });
}

export async function retryMessage(id: string, serviceId: string, acknowledgeUnknown: boolean) {
  return transaction(async client => {
    const owned = await client.query("SELECT 1 FROM messages WHERE id=$1 AND service_id=$2 FOR UPDATE", [id, serviceId]);
    if (!owned.rowCount) return null;
    const candidates = await client.query<{
      id: string;
      lifecycle_status: string;
      current_attempt_id: string | null;
    }>(
      `SELECT id,lifecycle_status,current_attempt_id FROM deliveries
       WHERE message_id=$1 AND compliance_status='clean' AND lifecycle_status IN ('failed','deferred','unknown')
       FOR UPDATE`,
      [id],
    );
    if (!acknowledgeUnknown && candidates.rows.some(row => row.lifecycle_status === "unknown")) {
      throw new DuplicateRiskError("Unknown outcomes require duplicate-risk acknowledgement.");
    }
    for (const delivery of candidates.rows) {
      if (delivery.current_attempt_id) {
        await client.query(
          "UPDATE delivery_attempts SET routing_snapshot=routing_snapshot||jsonb_build_object('serviceRetryAuthorizedAt',now()::text) WHERE id=$1",
          [delivery.current_attempt_id],
        );
        if (delivery.lifecycle_status === "unknown") {
          await client.query(
            "UPDATE delivery_attempts SET status='failed',outcome_determinate=true,error_category='unknown',error_code='service_override',error_message='Caller accepted duplicate risk' WHERE id=$1",
            [delivery.current_attempt_id],
          );
        }
      }
      await client.query("UPDATE deliveries SET lifecycle_status='queued',updated_at=now() WHERE id=$1", [delivery.id]);
      await client.query(
        "INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'delivery',$2,'delivery.requested',$3)",
        [createId("out"), delivery.id, { deliveryId: delivery.id }],
      );
    }
    return { messageId: id, queued: candidates.rowCount ?? 0 };
  });
}
