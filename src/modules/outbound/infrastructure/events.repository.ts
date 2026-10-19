import type { CanonicalEvent, CanonicalEventType, ProviderType } from "@/integrations/providers/contracts";
import type { PoolClient } from "pg";
import type { EventsRepository } from "../application/ports";
import type { Diagnostic } from "../domain/diagnostics";
export function createEventsRepository(client: Pick<PoolClient, "query">): EventsRepository {
    return {
        findCallbackMessage(input: {
            messageId: string;
            serviceId: string;
        }) {
            return client.query<Record<string, unknown>>("SELECT id FROM messages WHERE id=$1 AND service_id=$2 AND content_purged_at IS NULL", [input.messageId, input.serviceId]);
        },
        listSubscribedEndpoints(input: {
            serviceId: string;
            type: string;
        }) {
            return client.query<{
                id: string;
            }>("SELECT id FROM callback_endpoints WHERE service_id=$1 AND status='active' AND $2=ANY(subscribed_events)", [input.serviceId, input.type]);
        },
        insertCallbackDelivery(input: {
            id: string;
            endpointId: string;
            deliveryEventId: string | null;
            submissionEventId: string | null;
            type: string;
            payload: {
                id: string;
                apiVersion: string;
                type: string;
                scope: "recipient" | "submission";
                occurredAt: string;
                data: Record<string, unknown>;
            };
        }) {
            return client.query<Record<string, unknown>>(`INSERT INTO callback_deliveries(id,endpoint_id,delivery_event_id,submission_event_id,event_type,payload)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`, [input.id, input.endpointId, input.deliveryEventId, input.submissionEventId, input.type, input.payload]);
        },
        enqueueCallback(input: {
            outboxId: string;
            callbackDeliveryId: string;
            payload: {
                callbackDeliveryId: string;
            };
        }) {
            return client.query<Record<string, unknown>>("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'callback',$2,'callback.requested',$3)", [input.outboxId, input.callbackDeliveryId, input.payload]);
        },
        insertGlobalSuppression(input: {
            suppressionId: string;
            recipientEmail: string;
            reason: "suppressed" | "complained" | "hard_bounce";
        }) {
            return client.query<Record<string, unknown>>("INSERT INTO suppressions(id,scope_type,email_normalized,reason,source) VALUES ($1,'global',lower($2),$3,'provider_event') ON CONFLICT DO NOTHING", [input.suppressionId, input.recipientEmail, input.reason]);
        },
        insertUnsubscribeSuppression(input: {
            suppressionId: string;
            scope: "list" | "product";
            productId: string;
            listId: string | null;
            recipientEmail: string;
        }) {
            return client.query<Record<string, unknown>>("INSERT INTO suppressions(id,scope_type,product_id,list_id,email_normalized,reason,source) VALUES ($1,$2,$3,$4,lower($5),'unsubscribe','provider_event') ON CONFLICT DO NOTHING", [input.suppressionId, input.scope, input.productId, input.listId, input.recipientEmail]);
        },
        countRecentSoftBounces(input: {
            recipientEmail: string;
        }) {
            return client.query<{
                count: string;
            }>("SELECT count(*) FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id WHERE lower(d.recipient_email)=lower($1) AND de.event_type='bounced' AND de.canonical_payload#>>'{bounce,classification}'='soft' AND de.occurred_at>now()-interval '30 days'", [input.recipientEmail]);
        },
        insertSoftBounceSuppression(input: {
            suppressionId: string;
            recipientEmail: string;
            bounceCount: number;
        }) {
            return client.query<Record<string, unknown>>("INSERT INTO suppressions(id,scope_type,email_normalized,reason,source,bounce_count,expires_at) VALUES ($1,'global',lower($2),'soft_bounce_threshold','provider_event',$3,now()+interval '7 days') ON CONFLICT DO NOTHING", [input.suppressionId, input.recipientEmail, input.bounceCount]);
        },
        lockDeliveryState(input: {
            deliveryId: string;
        }) {
            return client.query<{
                current_attempt_id: string | null;
                current_submission_id: string | null;
                lifecycle_status: string;
            }>("SELECT current_attempt_id,current_submission_id,lifecycle_status FROM deliveries WHERE id=$1 FOR UPDATE", [input.deliveryId]);
        },
        findDeliveryContentPolicy(input: {
            deliveryId: string;
        }) {
            return client.query<{
                content_policy: string;
            }>("SELECT m.content_policy FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE d.id=$1", [input.deliveryId]);
        },
        insertDeliveryEvent(input: {
            eventId: string;
            deliveryId: string;
            rawEventId: string | null;
            type: "unknown" | "submitting" | CanonicalEventType | "queued" | "canceled";
            occurredAt: Date;
            payload: {
                id: string;
                attemptId: string | undefined;
                sourceId: string;
                metadata: {
                    diagnostic?: Diagnostic | undefined;
                };
                occurredAt: Date;
                externalMessageId?: string | undefined;
                recipient?: string | undefined;
                bounce?: {
                    classification: "hard" | "soft";
                    code?: string;
                    message?: string;
                } | undefined;
                inboundReference?: string | undefined;
                type: CanonicalEvent["type"] | "queued" | "submitting" | "unknown" | "canceled";
            };
            key: string;
        }) {
            return client.query<Record<string, unknown>>("INSERT INTO delivery_events(id,delivery_id,raw_provider_event_id,event_type,occurred_at,canonical_payload,source_key) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id", [input.eventId, input.deliveryId, input.rawEventId, input.type, input.occurredAt, input.payload, input.key]);
        },
        findAttemptSubmission(input: {
            attemptId: string;
        }) {
            return client.query<{
                submission_id: string;
            }>("SELECT submission_id FROM submission_attempts WHERE id=$1", [input.attemptId]);
        },
        restoreConclusiveAttempt(input: {
            deliveryId: string;
            attemptId: string;
            attemptSubmission: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE deliveries SET current_attempt_id=$2,current_submission_id=$3 WHERE id=$1", [input.deliveryId, input.attemptId, input.attemptSubmission]);
        },
        findLatestLifecycleEvent(input: {
            deliveryId: string;
            eventId: string;
            lifecycleTypes: string[];
            attemptId: string | null;
        }) {
            return client.query<{
                event_type: string;
                occurred_at: Date;
            }>(`SELECT event_type,occurred_at FROM delivery_events WHERE delivery_id=$1 AND id<>$2
      AND event_type=ANY($3::text[]) AND ($4::text IS NULL OR canonical_payload->>'attemptId'=$4)
      ORDER BY occurred_at DESC,CASE event_type WHEN 'canceled' THEN 8 WHEN 'bounced' THEN 7 WHEN 'delivered' THEN 6 WHEN 'failed' THEN 5 WHEN 'accepted' THEN 4 WHEN 'deferred' THEN 3 WHEN 'unknown' THEN 2 WHEN 'submitting' THEN 1 ELSE 0 END DESC,created_at DESC LIMIT 1`, [input.deliveryId, input.eventId, input.lifecycleTypes, input.attemptId]);
        },
        projectLifecycle(input: {
            deliveryId: string;
            type: "unknown" | "submitting" | CanonicalEventType | "queued" | "canceled";
            occurredAt: Date;
        }) {
            return client.query<Record<string, unknown>>("UPDATE deliveries SET lifecycle_status=$2,accepted_at=CASE WHEN $2='accepted' THEN COALESCE(accepted_at,$3) ELSE accepted_at END,delivered_at=CASE WHEN $2='delivered' THEN COALESCE(delivered_at,$3) ELSE delivered_at END,updated_at=now() WHERE id=$1", [input.deliveryId, input.type, input.occurredAt]);
        },
        projectEngagement(input: {
            deliveryId: string;
            type: "opened" | "clicked";
        }) {
            return client.query<Record<string, unknown>>("UPDATE deliveries SET engagement_status=CASE WHEN engagement_status='clicked' THEN 'clicked' ELSE $2 END,updated_at=now() WHERE id=$1", [input.deliveryId, input.type]);
        },
        projectCompliance(input: {
            deliveryId: string;
            type: "unknown" | "submitting" | CanonicalEventType | "queued" | "canceled";
        }) {
            return client.query<Record<string, unknown>>("UPDATE deliveries SET compliance_status=CASE WHEN compliance_status='complained' OR $2='complained' THEN 'complained' WHEN compliance_status='unsubscribed' OR $2='unsubscribed' THEN 'unsubscribed' ELSE 'suppressed' END,updated_at=now() WHERE id=$1", [input.deliveryId, input.type]);
        },
        failSuppressedDelivery(input: {
            deliveryId: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE deliveries SET lifecycle_status='failed' WHERE id=$1", [input.deliveryId]);
        },
        recordDeliveryDiagnostic(input: {
            deliveryId: string;
            error: Diagnostic;
        }) {
            return client.query<Record<string, unknown>>("UPDATE deliveries SET last_error=$2 WHERE id=$1", [input.deliveryId, input.error]);
        },
        clearDeliveryDiagnostic(input: {
            deliveryId: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE deliveries SET last_error=NULL WHERE id=$1", [input.deliveryId]);
        },
        findDeliveryCallbackContext(input: {
            deliveryId: string;
        }) {
            return client.query<{
                id: string;
                message_id: string;
                service_id: string;
                product_id: string;
                reference_id: string | null;
                request_id: string | null;
                recipient_email: string;
                recipient_role: string;
                product: string;
                category: string;
                lifecycle_status: string;
                engagement_status: string;
                compliance_status: string;
            }>("SELECT d.id,d.message_id,m.service_id,m.product_id,m.reference_id,m.request_id,d.recipient_email,d.recipient_role,p.name AS product,m.message_category AS category,d.lifecycle_status,d.engagement_status,d.compliance_status FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN products p ON p.id=m.product_id WHERE d.id=$1", [input.deliveryId]);
        },
        findSubmissionContentPolicy(input: {
            submissionId: string;
        }) {
            return client.query<{
                content_policy: string;
            }>("SELECT m.content_policy FROM messages m JOIN submissions s ON s.message_id=m.id WHERE s.id=$1", [input.submissionId]);
        },
        insertSubmissionEvent(input: {
            id: string;
            submissionId: string;
            attemptId: string | null;
            type: "unknown" | "submitting" | CanonicalEventType | "queued" | "canceled";
            key: string;
            occurredAt: Date;
            payload: {
                id: string;
                attemptId: string | undefined;
                sourceId: string;
                metadata: {
                    diagnostic?: Diagnostic | undefined;
                };
                occurredAt: Date;
                externalMessageId?: string | undefined;
                recipient?: string | undefined;
                bounce?: {
                    classification: "hard" | "soft";
                    code?: string;
                    message?: string;
                } | undefined;
                inboundReference?: string | undefined;
                type: CanonicalEvent["type"] | "queued" | "submitting" | "unknown" | "canceled";
            };
            rawEventId: string | null;
        }) {
            return client.query<Record<string, unknown>>("INSERT INTO submission_events(id,submission_id,attempt_id,event_type,source_key,occurred_at,canonical_payload,raw_provider_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id", [input.id, input.submissionId, input.attemptId, input.type, input.key, input.occurredAt, input.payload, input.rawEventId]);
        },
        findSubmissionOwner(input: {
            submissionId: string;
        }) {
            return client.query<{
                id: string;
                service_id: string;
                request_id: string | null;
                reference_id: string | null;
            }>("SELECT m.id,m.service_id,m.request_id,m.reference_id FROM messages m JOIN submissions s ON s.message_id=m.id WHERE s.id=$1", [input.submissionId]);
        },
        findProviderAttempt(input: {
            providerAccountId: string;
            externalMessageId: string | undefined;
        }) {
            return client.query<{
                id: string;
                submission_id: string;
                message_id: string;
            }>("SELECT a.id,a.submission_id,s.message_id FROM submission_attempts a JOIN submissions s ON s.id=a.submission_id WHERE a.provider_account_id=$1 AND a.external_message_id=$2", [input.providerAccountId, input.externalMessageId]);
        },
        lockEventMessage(input: {
            messageId: string;
        }) {
            return client.query<Record<string, unknown>>("SELECT id FROM messages WHERE id=$1 FOR UPDATE", [input.messageId]);
        },
        lockEventSubmission(input: {
            submissionId: string;
        }) {
            return client.query<Record<string, unknown>>("SELECT id FROM submissions WHERE id=$1 FOR UPDATE", [input.submissionId]);
        },
        lockEventAttempt(input: {
            id: string;
        }) {
            return client.query<Record<string, unknown>>("SELECT id FROM submission_attempts WHERE id=$1 FOR UPDATE", [input.id]);
        },
        listEventRecipients(input: {
            submissionId: string;
            recipient: string | null;
        }) {
            return client.query<{
                id: string;
            }>(`SELECT d.id FROM submission_deliveries sd JOIN deliveries d ON d.id=sd.delivery_id
      WHERE sd.submission_id=$1 AND ($2::text IS NULL OR lower(d.recipient_email)=lower($2)) ORDER BY d.id`, [input.submissionId, input.recipient]);
        },
        resolveVerifiedAcceptance(input: {
            id: string;
        }) {
            return client.query<{
                started_at: Date;
            }>(`UPDATE submission_attempts SET status='accepted',outcome_determinate=true,
        diagnostic=NULL,error_category=NULL,error_code=NULL,error_message=NULL,reconcile_after=NULL,finished_at=COALESCE(finished_at,now())
        WHERE id=$1 AND status IN ('submitting','unknown','reconciling') RETURNING started_at`, [input.id]);
        },
        acceptCurrentSubmission(input: {
            submissionId: string;
            relatedId: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submissions SET status='accepted',updated_at=now() WHERE id=$1 AND current_attempt_id=$2", [input.submissionId, input.relatedId]);
        },
        listSubmissionRecipients(input: {
            submissionId: string;
        }) {
            return client.query<{
                id: string;
            }>("SELECT delivery_id AS id FROM submission_deliveries WHERE submission_id=$1 ORDER BY delivery_id", [input.submissionId]);
        },
        claimProviderEvent(input: {
            rawEventId: string;
        }) {
            return client.query<{
                id: string;
                provider_account_id: string;
                webhook_endpoint_id: string;
                provider_type: ProviderType;
                processed_at: Date | null;
                verification: unknown;
                signature_valid: boolean;
                replay_valid: boolean;
                processing_attempt_count: number;
                raw_payload_purged_at: Date | null;
                normalized_events: Array<Omit<CanonicalEvent, "occurredAt"> & {
                    occurredAt: string;
                }> | null;
            }>(`UPDATE raw_provider_events r SET processing_attempt_count=processing_attempt_count+1,next_attempt_at=now()+interval '2 minutes'
    FROM provider_accounts a WHERE r.id=$1 AND a.id=r.provider_account_id AND r.processed_at IS NULL
      AND r.next_attempt_at<=now() AND r.processing_attempt_count<20 AND r.content_purged_at IS NULL AND r.terminated_at IS NULL
    RETURNING r.id,r.provider_account_id,r.webhook_endpoint_id,a.type AS provider_type,r.processed_at,r.verification,r.signature_valid,r.replay_valid,r.processing_attempt_count,r.raw_payload_purged_at,r.normalized_events`, [input.rawEventId]);
        },
        saveNormalizedFacts(input: {
            id: string;
            factsJson: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE raw_provider_events SET normalized_events=$2,payload_expires_at=COALESCE(payload_expires_at,clock_timestamp()+interval '15 minutes') WHERE id=$1", [input.id, input.factsJson]);
        },
        completeProviderEvent(input: {
            id: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE raw_provider_events SET processed_at=now(),processing_error=NULL WHERE id=$1", [input.id]);
        },
        lockProviderReceipt(input: {
            id: string;
        }) {
            return client.query<{
                raw_object_key: string | null;
                receipt_object_key: string | null;
            }>("SELECT raw_object_key,verification->>'objectKey' AS receipt_object_key FROM raw_provider_events WHERE id=$1 FOR UPDATE", [input.id]);
        },
        enqueueObjectDeletion(input: {
            key: string;
        }) {
            return client.query<Record<string, unknown>>("INSERT INTO pending_object_deletions(object_key) VALUES($1) ON CONFLICT DO NOTHING", [input.key]);
        },
        completeAndPurgeProviderReceipt(input: {
            id: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE raw_provider_events SET processed_at=now(),processing_error=NULL,raw_body=NULL,raw_object_key=NULL,verification='{}',headers='{}',raw_payload_purged_at=clock_timestamp() WHERE id=$1", [input.id]);
        },
        rejectInboundReceipt(input: {
            id: string;
            message: "Inbound event processing was rejected." | "Provider event processing failed; durable verified receipt/facts retained for retry.";
        }) {
            return client.query<Record<string, unknown>>("UPDATE raw_provider_events SET processed_at=now(),processing_error=$2 WHERE id=$1", [input.id, input.message]);
        },
        deferProviderEvent(input: {
            id: string;
            message: "Inbound event processing was rejected." | "Provider event processing failed; durable verified receipt/facts retained for retry.";
        }) {
            return client.query<Record<string, unknown>>("UPDATE raw_provider_events SET processing_error=$2,next_attempt_at=now()+interval '30 seconds' WHERE id=$1", [input.id, input.message]);
        },
        enqueueProviderEvent(input: {
            outboxId: string;
            rawEventId: string;
            eventType: string;
            payload: {
                rawEventId: string;
            };
        }) {
            return client.query<Record<string, unknown>>("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'raw_provider_event',$2,$3,$4,now()+interval '30 seconds')", [input.outboxId, input.rawEventId, input.eventType, input.payload]);
        },
    };
}
