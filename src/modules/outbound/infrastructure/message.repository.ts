import type { ProviderType } from "@/integrations/providers/contracts";
import { deliveryStatuses } from "@/lib/contracts";
import { outboundDomainAccess } from "@/modules/identity/infrastructure/authorization";
import { database } from "@/platform/database";
import { messages } from "@/platform/database/schema/outbound";
import type { Pool, PoolClient } from "pg";
import type { MessageRepository } from "../application/ports";
import type { MessageContent, MessageRow } from "../contracts";
const stats = `JOIN LATERAL (SELECT count(*)::int AS total,
  count(*) FILTER(WHERE lifecycle_status='queued')::int AS queued,
  count(*) FILTER(WHERE lifecycle_status=ANY(ARRAY['queued','submitting','accepted','deferred']))::int AS active,
  count(*) FILTER(WHERE lifecycle_status='unknown')::int AS unknown,
  count(*) FILTER(WHERE lifecycle_status='delivered')::int AS delivered,
  count(*) FILTER(WHERE lifecycle_status='canceled')::int AS canceled,
  jsonb_build_object(${deliveryStatuses.map(status => `'${status}',count(*) FILTER(WHERE lifecycle_status='${status}')`).join(",")},'suppressed',count(*) FILTER(WHERE compliance_status='suppressed')) AS counts
  FROM deliveries WHERE message_id=m.id) ds ON true`;
const projection = `SELECT m.*,m.sender_snapshot->>'product' AS product,m.message_category AS category,ds.counts,
  CASE WHEN ds.queued=ds.total THEN 'queued' WHEN ds.active>0 OR ds.unknown>0 THEN 'processing' ELSE 'finished' END AS processing_state,
  CASE WHEN ds.unknown>0 THEN 'unknown' WHEN ds.active>0 THEN 'pending' WHEN ds.delivered=ds.total THEN 'succeeded'
    WHEN ds.canceled=ds.total THEN 'canceled' WHEN ds.delivered>0 THEN 'partially_failed' ELSE 'failed' END AS outcome,
  to_char(m.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
  FROM messages m ${stats}`;
export function createMessageRepository(client: Pool | PoolClient): MessageRepository {
    return {
        isRecipientSuppressed(input: {
            email: string;
            productId: string;
            listId: string | null;
        }) {
            return client.query<Record<string, unknown>>(`SELECT 1 FROM suppressions WHERE active=true AND email_normalized=lower($1)
    AND (expires_at IS NULL OR expires_at>now()) AND (scope_type='global' OR (scope_type='product' AND product_id=$2)
    OR (scope_type='list' AND product_id=$2 AND list_id=$3)) LIMIT 1`, [input.email, input.productId, input.listId]);
        },
        findConfiguredProviderTypes(input: {
            sendingDomainId: string;
            productId: string;
            serviceId: string;
            messageCategory: string;
        }) {
            return client.query<{
                type: ProviderType;
            }>(`SELECT DISTINCT pa.type FROM routing_policies rp
    JOIN routing_targets rt ON rt.policy_id=rp.id JOIN provider_accounts pa ON pa.id=rt.provider_account_id
    JOIN provider_identities pi ON pi.id=rt.provider_identity_id AND pi.provider_account_id=pa.id
    WHERE rp.sending_domain_id=$1 AND pi.sending_domain_id=$1 AND pi.status='verified' AND rp.status='active'
      AND (rp.product_id IS NULL OR rp.product_id=$2) AND (rp.service_id IS NULL OR rp.service_id=$3)
      AND (rp.message_category IS NULL OR rp.message_category=$4)`, [input.sendingDomainId, input.productId, input.serviceId, input.messageCategory]);
        },
        insertSubmission(input: {
            id: string;
            messageId: string;
        }) {
            return client.query<Record<string, unknown>>("INSERT INTO submissions(id,message_id) VALUES ($1,$2)", [input.id, input.messageId]);
        },
        insertSubmissionRecipients(input: {
            id: string;
            deliveryIds: string[];
        }) {
            return client.query<Record<string, unknown>>("INSERT INTO submission_deliveries(submission_id,delivery_id) SELECT $1,unnest($2::text[])", [input.id, input.deliveryIds]);
        },
        assignSubmissionToDeliveries(input: {
            id: string;
            deliveryIds: string[];
        }) {
            return client.query<Record<string, unknown>>("UPDATE deliveries SET current_submission_id=$1,current_attempt_id=NULL WHERE id=ANY($2::text[])", [input.id, input.deliveryIds]);
        },
        enqueueSubmission(input: {
            outboxId: string;
            submissionId: string;
            payload: {
                submissionId: string;
            };
        }) {
            return client.query<Record<string, unknown>>("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'submission',$2,'submission.requested',$3)", [input.outboxId, input.submissionId, input.payload]);
        },
        lockIdempotencyKey(input: {
            lockKey: string;
        }) {
            return client.query<Record<string, unknown>>("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [input.lockKey]);
        },
        findIdempotentMessage(input: {
            serviceId: string;
            idempotencyKey: string;
        }) {
            return client.query<{
                id: string;
                payload_hash: string;
                payload_hash_key_version: string | null;
                accepted_at: Date;
                product: string;
                message_category: string;
                recipient_count: number;
                reference_id: string | null;
            }>("SELECT id,payload_hash,payload_hash_key_version,accepted_at,sender_snapshot->>'product' AS product,message_category,recipient_count,reference_id FROM messages WHERE service_id=$1 AND idempotency_key=$2 FOR UPDATE", [input.serviceId, input.idempotencyKey]);
        },
        async insertMessage(input: {
            content: MessageContent;
            recipientCount: number;
            requestId: string | null;
            idempotencyKey: string;
            payloadHash: string;
            referenceId: string | null;
            keyVersion: string | null;
        }) {
            const content = input.content;
            const accepted = await database(client).insert(messages).values({
                id: content.id, productId: content.product_id, serviceId: content.service_id, sendingDomainId: content.sending_domain_id,
                requestId: input.requestId, idempotencyKey: input.idempotencyKey, payloadHash: input.payloadHash,
                referenceId: input.referenceId, metadata: content.metadata, recipientCount: input.recipientCount,
                subject: content.subject, htmlBody: content.html_body, textBody: content.text_body, messageCategory: content.message_category,
                replyTo: content.reply_to, providerTags: content.provider_tags, senderSnapshot: content.sender_snapshot,
                toRecipients: content.to_recipients, ccRecipients: content.cc_recipients, bccRecipients: content.bcc_recipients,
                headers: content.headers, inReplyTo: content.in_reply_to, referencesIds: content.references_ids,
                attachmentSnapshot: content.attachment_snapshot, contentPolicy: content.content_policy ?? "normal",
                sendBefore: content.send_before?.toISOString() ?? null, sensitiveContent: content.sensitive_content ?? null,
                payloadHashKeyVersion: input.keyVersion,
            }).returning({ acceptedAt: messages.acceptedAt });
            return { rows: accepted.map(row => ({ accepted_at: new Date(row.acceptedAt) })), rowCount: accepted.length };
        },
        insertDelivery(input: {
            deliveryId: string;
            messageId: string;
            email: string;
            recipientName: string | null;
            role: "to" | "cc" | "bcc";
        }) {
            return client.query<Record<string, unknown>>("INSERT INTO deliveries(id,message_id,recipient_email,recipient_name,recipient_role) VALUES ($1,$2,$3,$4,$5)", [input.deliveryId, input.messageId, input.email, input.recipientName, input.role]);
        },
        listAuthorizedMessages(input: {
            serviceId: string;
            referenceId: string | null;
            at: string | Date | null;
            relatedId: string | null;
            processingState: string | null;
            outcome: string | null;
            limit: number;
        }) {
            return client.query<MessageRow>(`SELECT * FROM (${projection} WHERE m.service_id=$1 AND ${outboundDomainAccess('m')}
    AND ($2::text IS NULL OR m.reference_id=$2) AND ($3::timestamptz IS NULL OR (m.accepted_at,m.id)<($3,$4))) result
    WHERE ($5::text IS NULL OR processing_state=$5) AND ($6::text IS NULL OR outcome=$6)
    ORDER BY accepted_at DESC,id DESC LIMIT $7`, [input.serviceId, input.referenceId, input.at, input.relatedId, input.processingState, input.outcome, input.limit]);
        },
        findAuthorizedMessage(input: {
            id: string;
            serviceId: string;
        }) {
            return client.query<MessageRow>(`${projection} WHERE m.id=$1 AND m.service_id=$2 AND ${outboundDomainAccess('m')}`, [input.id, input.serviceId]);
        },
        listMessageDeliveries(input: {
            id: string;
        }) {
            return client.query<{
                id: string;
                recipient_email: string;
                recipient_name: string | null;
                recipient_role: "to" | "cc" | "bcc";
                lifecycle_status: string;
                engagement_status: string;
                compliance_status: string;
                last_error: unknown;
                updated_at: Date;
                accepted_at: Date | null;
                delivered_at: Date | null;
            }>("SELECT id,recipient_email,recipient_name,recipient_role,lifecycle_status,engagement_status,compliance_status,last_error,updated_at,accepted_at,delivered_at FROM deliveries WHERE message_id=$1 ORDER BY queued_at,id", [input.id]);
        },
        lockAuthorizedMessage(input: {
            id: string;
            serviceId: string;
        }) {
            return client.query<Record<string, unknown>>(`SELECT id FROM messages m WHERE id=$1 AND service_id=$2 AND ${outboundDomainAccess('m')} FOR UPDATE`, [input.id, input.serviceId]);
        },
        lockMessageSubmissions(input: {
            id: string;
        }) {
            return client.query<Record<string, unknown>>("SELECT id FROM submissions WHERE message_id=$1 ORDER BY id FOR UPDATE", [input.id]);
        },
        lockCancelableDeliveries(input: {
            id: string;
        }) {
            return client.query<{
                id: string;
            }>(`SELECT d.id FROM deliveries d LEFT JOIN submission_attempts a ON a.id=d.current_attempt_id
      WHERE d.message_id=$1 AND d.lifecycle_status IN ('queued','deferred')
      AND (a.id IS NULL OR (a.outcome_determinate AND a.status='failed')) ORDER BY d.id FOR UPDATE OF d`, [input.id]);
        },
        cancelEmptySubmissions(input: {
            id: string;
        }) {
            return client.query<Record<string, unknown>>(`UPDATE submissions s SET status='canceled',updated_at=now() WHERE message_id=$1 AND status IN ('queued','deferred')
      AND NOT EXISTS(SELECT 1 FROM submission_deliveries sd JOIN deliveries d ON d.id=sd.delivery_id WHERE sd.submission_id=s.id AND d.lifecycle_status IN ('queued','deferred','submitting'))`, [input.id]);
        },
        lockDeliveryRetryState(input: {
            deliveryId: string;
        }) {
            return client.query<{
                id: string;
                message_id: string;
                service_id: string;
                lifecycle_status: string;
                compliance_status: string;
                current_attempt_id: string | null;
                uncertain: boolean;
                live: boolean;
                provider_pending: boolean;
                content_expired: boolean;
                deadline_expired: boolean;
                enabled: boolean;
                blocked: boolean;
            }>(`SELECT d.id,d.message_id,m.service_id,d.lifecycle_status,d.compliance_status,d.current_attempt_id,
    COALESCE(NOT a.outcome_determinate,false) AS uncertain,(a.status='submitting') IS TRUE AS live,(a.status IN ('accepted','reconciled') AND d.lifecycle_status='deferred') IS TRUE AS provider_pending,m.content_purged_at IS NOT NULL AS content_expired,(m.send_before<=clock_timestamp()) IS TRUE AS deadline_expired,
    ${outboundDomainAccess('m')} AS enabled,
    EXISTS(SELECT 1 FROM suppressions su WHERE su.active AND su.email_normalized=lower(d.recipient_email) AND (su.expires_at IS NULL OR su.expires_at>now())
      AND (su.scope_type='global' OR (su.product_id=m.product_id AND (su.scope_type='product' OR su.list_id=m.metadata->>'listId')))) AS blocked
    FROM deliveries d JOIN messages m ON m.id=d.message_id LEFT JOIN submission_attempts a ON a.id=d.current_attempt_id WHERE d.id=$1 FOR UPDATE OF d`, [input.deliveryId]);
        },
        lockDeliveryMessage(input: {
            deliveryId: string;
        }) {
            return client.query<Record<string, unknown>>("SELECT m.id FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE d.id=$1 FOR UPDATE OF m", [input.deliveryId]);
        },
        lockRetryMessage(input: {
            id: string;
            serviceId: string;
        }) {
            return client.query<MessageContent>(`SELECT * FROM messages m WHERE id=$1 AND service_id=$2 AND ${outboundDomainAccess('m')} FOR UPDATE`, [input.id, input.serviceId]);
        },
        findRetryReceipt(input: {
            id: string;
            idempotencyKey: string;
        }) {
            return client.query<{
                payload_hash: string;
                result: {
                    messageId: string;
                    submissionId: string | null;
                    queued: number;
                    skipped: {
                        deliveryId: string;
                        reason: string | null;
                    }[];
                };
            }>("SELECT payload_hash,result FROM message_retries WHERE message_id=$1 AND idempotency_key=$2", [input.id, input.idempotencyKey]);
        },
        lockRetrySubmissions(input: {
            id: string;
        }) {
            return client.query<Record<string, unknown>>("SELECT id FROM submissions WHERE message_id=$1 ORDER BY id FOR UPDATE", [input.id]);
        },
        listRetryRecipients(input: {
            id: string;
        }) {
            return client.query<{
                id: string;
                recipient_email: string;
                recipient_name: string | null;
            }>("SELECT id,recipient_email,recipient_name FROM deliveries WHERE message_id=$1 ORDER BY id", [input.id]);
        },
        authorizeAttemptRetry(input: {
            currentAttemptId: string;
            actor: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submission_attempts SET retry_authorized_at=now(),retry_authorized_by=$2 WHERE id=$1", [input.currentAttemptId, input.actor]);
        },
        saveRetryReceipt(input: {
            id: string;
            idempotencyKey: string;
            payloadHash: string;
            result: {
                messageId: string;
                submissionId: string | null;
                queued: number;
                skipped: {
                    deliveryId: string;
                    reason: string | null;
                }[];
            };
        }) {
            return client.query<Record<string, unknown>>("INSERT INTO message_retries(message_id,idempotency_key,payload_hash,result) VALUES ($1,$2,$3,$4)", [input.id, input.idempotencyKey, input.payloadHash, input.result]);
        },
        findDeliveryOwner(input: {
            deliveryId: string;
        }) {
            return client.query<{
                id: string;
                service_id: string;
            }>("SELECT m.id,m.service_id FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE d.id=$1", [input.deliveryId]);
        },
    };
}
