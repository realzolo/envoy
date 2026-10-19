import type { PoolClient } from "pg";
import type { RoutingRepository } from "../application/ports";
import type { Attempt, Candidate, MessageContent, Recipient, Submission } from "../contracts";
import type { Diagnostic } from "../domain/diagnostics";
export function createRoutingRepository(client: Pick<PoolClient, "query">): RoutingRepository {
    return {
        lockAccountQuota(input: {
            providerAccountId: string;
        }) {
            return client.query<{
                quota: Record<string, unknown>;
            }>("SELECT quota FROM provider_accounts WHERE id=$1 FOR UPDATE", [input.providerAccountId]);
        },
        readAccountUsage(input: {
            providerAccountId: string;
        }) {
            return client.query<{
                monthly: string;
                daily: string;
            }>(`SELECT
    count(*) FILTER (WHERE a.started_at>=date_trunc('month',now())) AS monthly,
    count(*) FILTER (WHERE a.started_at>=date_trunc('day',now())) AS daily
    FROM submission_attempts a JOIN submission_deliveries sd ON sd.submission_id=a.submission_id
    WHERE a.provider_account_id=$1 AND a.status IN ('submitting','accepted','reconciled','unknown','reconciling')`, [input.providerAccountId]);
        },
        lockSubmissionRecipients(input: {
            submissionId: string;
        }) {
            return client.query<Recipient>(`SELECT d.* FROM submission_deliveries sd JOIN deliveries d ON d.id=sd.delivery_id
    WHERE sd.submission_id=$1 ORDER BY d.id FOR UPDATE OF d`, [input.submissionId]);
        },
        enqueueSubmission(input: {
            outboxId: string;
            submissionId: string;
            payload: {
                submissionId: string;
            };
            seconds: number;
        }) {
            return client.query<Record<string, unknown>>("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'submission',$2,'submission.requested',$3,now()+$4*interval '1 second')", [input.outboxId, input.submissionId, input.payload, input.seconds]);
        },
        enqueueReconciliation(input: {
            outboxId: string;
            attemptId: string;
            payload: {
                attemptId: string;
            };
            seconds: number;
        }) {
            return client.query<Record<string, unknown>>("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'attempt',$2,'submission.reconcile',$3,now()+$4*interval '1 second')", [input.outboxId, input.attemptId, input.payload, input.seconds]);
        },
        incrementDeferralCount(input: {
            id: string;
        }) {
            return client.query<{
                defer_count: number;
            }>("UPDATE submissions SET defer_count=defer_count+1,updated_at=now() WHERE id=$1 RETURNING defer_count", [input.id]);
        },
        setRoutingResult(input: {
            id: string;
            status: "failed" | "deferred";
        }) {
            return client.query<Record<string, unknown>>("UPDATE submissions SET status=$2 WHERE id=$1", [input.id, input.status]);
        },
        findSubmissionOwner(input: {
            submissionId: string;
        }) {
            return client.query<{
                message_id: string;
            }>("SELECT message_id FROM submissions WHERE id=$1", [input.submissionId]);
        },
        lockSubmissionMessage(input: {
            messageId: string;
        }) {
            return client.query<MessageContent>("SELECT * FROM messages WHERE id=$1 FOR UPDATE", [input.messageId]);
        },
        lockSubmission(input: {
            submissionId: string;
        }) {
            return client.query<Submission>("SELECT * FROM submissions WHERE id=$1 FOR UPDATE", [input.submissionId]);
        },
        lockCurrentAttempt(input: {
            currentAttemptId: string;
        }) {
            return client.query<Attempt>(`SELECT a.*,s.current_attempt_id=a.id AS is_current,a.submission_deadline_at<=now() AS submission_expired
      FROM submission_attempts a JOIN submissions s ON s.id=a.submission_id WHERE a.id=$1 FOR UPDATE OF a`, [input.currentAttemptId]);
        },
        recordInterruptedAttempt(input: {
            id: string;
            code: string;
            message: string;
            error: Diagnostic;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submission_attempts SET status='unknown',outcome_determinate=false,error_category='unknown',error_code=$2,error_message=$3,diagnostic=$4,finished_at=now(),reconcile_after=now()+interval '30 seconds' WHERE id=$1", [input.id, input.code, input.message, input.error]);
        },
        setInterruptedSubmission(input: {
            submissionId: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submissions SET status='unknown',updated_at=now() WHERE id=$1", [input.submissionId]);
        },
        cancelInactiveSubmission(input: {
            submissionId: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submissions SET status='canceled',updated_at=now() WHERE id=$1", [input.submissionId]);
        },
        cancelSuppressedSubmission(input: {
            submissionId: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submissions SET status='canceled',updated_at=now() WHERE id=$1", [input.submissionId]);
        },
        cancelChangedEnvelope(input: {
            submissionId: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submissions SET status='canceled',updated_at=now() WHERE id=$1", [input.submissionId]);
        },
        listRoutingCandidates(input: {
            sendingDomainId: string;
            productId: string;
            serviceId: string;
            messageCategory: string;
        }) {
            return client.query<Candidate>(`SELECT rt.id AS target_id,rp.id AS policy_id,rp.name AS policy_name,rp.priority AS policy_priority,rt.provider_account_id,rt.provider_identity_id,
      pa.type AS provider_type,pa.name AS provider_name,rt.priority,rt.weight,rt.rate_limit_per_minute,sd.domain,pa.quota,rt.status,rt.circuit_open_until,pa.status AS account_status,pa.health,pi.status AS identity_status,sd.status AS domain_status,
      usage.monthly_usage::text,usage.daily_usage::text
      FROM routing_policies rp JOIN routing_targets rt ON rt.policy_id=rp.id
      JOIN provider_accounts pa ON pa.id=rt.provider_account_id JOIN provider_identities pi ON pi.id=rt.provider_identity_id
      JOIN sending_domains sd ON sd.id=pi.sending_domain_id
      CROSS JOIN LATERAL (SELECT count(*) FILTER (WHERE a.started_at>=date_trunc('month',now())) AS monthly_usage,
        count(*) FILTER (WHERE a.started_at>=date_trunc('day',now())) AS daily_usage
        FROM submission_attempts a JOIN submission_deliveries sm ON sm.submission_id=a.submission_id
        WHERE a.provider_account_id=pa.id AND a.status IN ('submitting','accepted','reconciled','unknown','reconciling')) usage
      WHERE rp.status='active' AND rp.sending_domain_id=$1 AND pi.sending_domain_id=$1 AND pi.provider_account_id=pa.id
        AND (rp.product_id IS NULL OR rp.product_id=$2) AND (rp.service_id IS NULL OR rp.service_id=$3)
        AND (rp.message_category IS NULL OR rp.message_category=$4)
      ORDER BY rp.priority,rt.priority,rt.id`, [input.sendingDomainId, input.productId, input.serviceId, input.messageCategory]);
        },
        listFailedAccounts(input: {
            submissionId: string;
        }) {
            return client.query<{
                provider_account_id: string;
            }>("SELECT DISTINCT provider_account_id FROM submission_attempts WHERE submission_id=$1 AND status='failed'", [input.submissionId]);
        },
        beginCapacityReservation() {
            return client.query<Record<string, unknown>>("SAVEPOINT routing_capacity", []);
        },
        commitCapacityReservation() {
            return client.query<Record<string, unknown>>("RELEASE SAVEPOINT routing_capacity", []);
        },
        rollbackCapacityReservation() {
            return client.query<Record<string, unknown>>("ROLLBACK TO SAVEPOINT routing_capacity", []);
        },
        releaseCapacityReservation() {
            return client.query<Record<string, unknown>>("RELEASE SAVEPOINT routing_capacity", []);
        },
        closeExpiredCircuit(input: {
            targetId: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE routing_targets SET status='active',circuit_open_until=NULL,updated_at=now() WHERE id=$1 AND status='circuit_open'", [input.targetId]);
        },
        insertAttempt(input: {
            attemptId: string;
            submissionId: string;
            attemptNumber: number;
            providerAccountId: string;
            providerIdentityId: string;
            snapshot: {
                policy: {
                    id: string;
                    name: string;
                    priority: number;
                };
                chosen: {
                    targetId: string;
                    accountId: string;
                    identityId: string;
                    providerType: "resend" | "ses" | "sendgrid" | "mailgun" | "postmark" | "mock";
                    nativeIdempotency: boolean;
                };
                candidates: {
                    targetId: string;
                    policyId: string;
                    policyPriority: number;
                    accountId: string;
                    identityId: string;
                    priority: number;
                    weight: number;
                    reasons: string[];
                    capabilityIssue: string | null;
                }[];
                selectedAt: string;
                recipientCount: number;
            };
            fingerprint: string;
            providerIdempotencyKey: string | null;
        }) {
            return client.query<Record<string, unknown>>(`INSERT INTO submission_attempts(id,submission_id,attempt_number,provider_account_id,provider_identity_id,routing_snapshot,request_fingerprint,provider_idempotency_key,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'submitting')`, [input.attemptId, input.submissionId, input.attemptNumber, input.providerAccountId, input.providerIdentityId, input.snapshot, input.fingerprint, input.providerIdempotencyKey]);
        },
        startSubmissionAttempt(input: {
            submissionId: string;
            attemptId: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submissions SET status='submitting',current_attempt_id=$2,updated_at=now() WHERE id=$1", [input.submissionId, input.attemptId]);
        },
        assignDeliveryAttempt(input: {
            id: string;
            attemptId: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE deliveries SET current_attempt_id=$2 WHERE id=$1", [input.id, input.attemptId]);
        },
        findAttemptOwner(input: {
            attemptId: string;
        }) {
            return client.query<{
                submission_id: string;
                message_id: string;
            }>("SELECT a.submission_id,s.message_id FROM submission_attempts a JOIN submissions s ON s.id=a.submission_id WHERE a.id=$1", [input.attemptId]);
        },
        lockAttemptMessage(input: {
            messageId: string;
        }) {
            return client.query<Record<string, unknown>>("SELECT id FROM messages WHERE id=$1 FOR UPDATE", [input.messageId]);
        },
        lockAttemptSubmission(input: {
            submissionId: string;
        }) {
            return client.query<Record<string, unknown>>("SELECT id FROM submissions WHERE id=$1 FOR UPDATE", [input.submissionId]);
        },
        lockAttempt(input: {
            attemptId: string;
        }) {
            return client.query<Attempt>(`SELECT a.*,s.current_attempt_id=a.id AS is_current,a.submission_deadline_at<=now() AS submission_expired,m.content_policy,m.send_before
    FROM submission_attempts a JOIN submissions s ON s.id=a.submission_id JOIN messages m ON m.id=s.message_id WHERE a.id=$1 FOR UPDATE OF a`, [input.attemptId]);
        },
        acceptAttempt(input: {
            attemptId: string;
            externalMessageId: string;
            responseJson: string;
            rfcMessageId: string | null;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submission_attempts SET status='accepted',outcome_determinate=true,external_message_id=$2,provider_response_ref=$3,rfc_message_id=$4,finished_at=now(),reconcile_after=NULL,diagnostic=NULL,error_category=NULL,error_code=NULL,error_message=NULL WHERE id=$1", [input.attemptId, input.externalMessageId, input.responseJson, input.rfcMessageId]);
        },
        acceptSubmission(input: {
            submissionId: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submissions SET status='accepted',updated_at=now() WHERE id=$1", [input.submissionId]);
        },
        resetCircuit(input: {
            targetId: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE routing_targets SET status='active',circuit_open_until=NULL,updated_at=now() WHERE id=$1", [input.targetId]);
        },
        markAttemptUnknown(input: {
            attemptId: string;
            code: string;
            message: string;
            error: Diagnostic;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submission_attempts SET status='unknown',outcome_determinate=false,error_category='unknown',error_code=$2,error_message=$3,diagnostic=$4,finished_at=now(),reconcile_after=now()+interval '30 seconds' WHERE id=$1", [input.attemptId, input.code, input.message, input.error]);
        },
        markSubmissionUnknown(input: {
            submissionId: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submissions SET status='unknown',updated_at=now() WHERE id=$1", [input.submissionId]);
        },
        failAttempt(input: {
            attemptId: string;
            category: string;
            code: string;
            message: string;
            error: Diagnostic;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submission_attempts SET status='failed',outcome_determinate=true,error_category=$2,error_code=$3,error_message=$4,diagnostic=$5,finished_at=now(),reconcile_after=NULL WHERE id=$1", [input.attemptId, input.category, input.code, input.message, input.error]);
        },
        setFailureResult(input: {
            submissionId: string;
            status: "failed" | "deferred";
        }) {
            return client.query<Record<string, unknown>>("UPDATE submissions SET status=$2,updated_at=now() WHERE id=$1", [input.submissionId, input.status]);
        },
        readCircuitFailureWindow(input: {
            targetId: string;
            categories: string[];
            threshold: number;
        }) {
            return client.query<{
                sample_count: string;
                all_failed: boolean;
            }>("SELECT count(*)::text AS sample_count,COALESCE(bool_and(status='failed' AND error_category=ANY($2::text[])),false) AS all_failed FROM (SELECT status,error_category FROM submission_attempts WHERE routing_snapshot#>>'{chosen,targetId}'=$1 ORDER BY started_at DESC LIMIT $3) samples", [input.targetId, input.categories, input.threshold]);
        },
        openCircuit(input: {
            targetId: string;
            seconds: number;
        }) {
            return client.query<Record<string, unknown>>("UPDATE routing_targets SET status='circuit_open',circuit_open_until=now()+$2*interval '1 second',updated_at=now() WHERE id=$1", [input.targetId, input.seconds]);
        },
        claimReconciliation(input: {
            attemptId: string;
        }) {
            return client.query<{
                id: string;
                submission_id: string;
                provider_account_id: string;
                external_message_id: string | null;
                request_fingerprint: string;
                status: string;
            }>(`UPDATE submission_attempts a SET reconciliation_count=reconciliation_count+1,reconcile_after=now()+interval '2 minutes'
    FROM submissions s WHERE a.id=$1 AND s.current_attempt_id=a.id AND a.status IN ('unknown','reconciling')
      AND EXISTS(SELECT 1 FROM deliveries d WHERE d.current_attempt_id=a.id AND d.current_submission_id=a.submission_id) AND a.reconcile_after<=now() AND a.reconciliation_count<12
    RETURNING a.id,a.submission_id,a.provider_account_id,a.external_message_id,a.request_fingerprint,a.status`, [input.attemptId]);
        },
        recordUncertainReconciliation(input: {
            attemptId: string;
            status: "unknown" | "reconciling";
            exhausted: boolean;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submission_attempts SET status=$2,reconcile_after=CASE WHEN $3 THEN NULL ELSE now()+interval '5 minutes' END WHERE id=$1", [input.attemptId, input.status, input.exhausted]);
        },
        recordReconciliationExhaustion(input: {
            attemptId: string;
            error: Diagnostic;
            code: string;
            message: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submission_attempts SET diagnostic=$2,error_code=$3,error_message=$4 WHERE id=$1", [input.attemptId, input.error, input.code, input.message]);
        },
        resolveAttemptReconciliation(input: {
            attemptId: string;
            status: "failed" | "reconciled";
            diagnostic: Diagnostic | null;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submission_attempts SET status=$2,outcome_determinate=true,finished_at=now(),reconcile_after=NULL,diagnostic=$3,error_category=CASE WHEN $2='reconciled' THEN NULL ELSE error_category END,error_code=CASE WHEN $2='reconciled' THEN NULL ELSE error_code END,error_message=CASE WHEN $2='reconciled' THEN NULL ELSE error_message END WHERE id=$1", [input.attemptId, input.status, input.diagnostic]);
        },
        setReconciliationResult(input: {
            submissionId: string;
            status: "failed" | "deferred" | "accepted";
        }) {
            return client.query<Record<string, unknown>>("UPDATE submissions SET status=$2,updated_at=now() WHERE id=$1", [input.submissionId, input.status]);
        },
        findWorkflowOwner(input: {
            submissionId: string;
        }) {
            return client.query<{
                message_id: string;
            }>("SELECT message_id FROM submissions WHERE id=$1", [input.submissionId]);
        },
        lockWorkflowContent(input: {
            messageId: string;
        }) {
            return client.query<{
                content_policy: string;
            }>("SELECT content_policy FROM messages WHERE id=$1 FOR UPDATE", [input.messageId]);
        },
        lockWorkflowSubmission(input: {
            submissionId: string;
        }) {
            return client.query<Submission>("SELECT * FROM submissions WHERE id=$1 FOR UPDATE", [input.submissionId]);
        },
        deferWorkflow(input: {
            submissionId: string;
        }) {
            return client.query<Record<string, unknown>>("UPDATE submissions SET status='deferred',updated_at=now() WHERE id=$1", [input.submissionId]);
        },
    };
}
