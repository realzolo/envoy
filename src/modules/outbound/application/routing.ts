import { diagnostic, type Diagnostic } from "@/modules/outbound/domain/diagnostics";
import { createId } from "@/platform/ids";
import { createHash } from "node:crypto";
import type { Attempt, Candidate, DeliveryStateEvent, DeliverySubmission, Recipient, Submission } from "../contracts";
import { assertSendDeadline, DEADLINE_CODE, DEADLINE_MESSAGE } from "../domain/deadline";
import { canonicalMessage, capabilityIssue, subsetEnvelope } from "../domain/message";
import { configuredLimit, evaluateCandidate } from "../domain/routing";
import type { OutboundDependencies, OutboundRepositories } from "./ports";
export function createRoutingService(dependencies: OutboundDependencies) {
    const { applyDeliveryEvent, applySubmissionEvent } = dependencies.events;
    const { createSubmission, isSuppressed } = dependencies.messages;
    async function reserveProviderCapacity(client: OutboundRepositories, candidate: Candidate, recipients: number) {
        const account = (await client.routing.lockAccountQuota({ providerAccountId: candidate.provider_account_id })).rows[0];
        if (!account)
            return false;
        const monthly = configuredLimit(account.quota, "monthlyLimit");
        const daily = configuredLimit(account.quota, "dailyLimit");
        if (monthly === null || daily === null)
            return false;
        const usage = (await client.routing.readAccountUsage({ providerAccountId: candidate.provider_account_id })).rows[0];
        return (monthly === undefined || Number(usage.monthly) + recipients <= monthly) && (daily === undefined || Number(usage.daily) + recipients <= daily);
    }
    async function recipients(client: OutboundRepositories, submissionId: string) {
        return (await client.routing.lockSubmissionRecipients({ submissionId: submissionId })).rows;
    }
    async function enqueue(client: OutboundRepositories, submissionId: string, seconds: number) {
        await client.routing.enqueueSubmission({ outboxId: createId("out"), submissionId: submissionId, payload: { submissionId }, seconds: seconds });
    }
    async function enqueueReconciliation(client: OutboundRepositories, attemptId: string, seconds: number) {
        await client.routing.enqueueReconciliation({ outboxId: createId("out"), attemptId: attemptId, payload: { attemptId }, seconds: seconds });
    }
    async function emit(client: OutboundRepositories, submissionId: string, type: DeliveryStateEvent["type"], key: string, error?: Diagnostic, attempt?: Attempt, occurredAt = new Date(), projectLifecycle = true) {
        const event: DeliveryStateEvent = { id: key, type, occurredAt, metadata: error ? { diagnostic: error } : {} };
        await applySubmissionEvent(client, submissionId, event, `${key}:submission`, attempt?.id);
        for (const row of await recipients(client, submissionId)) {
            if (!attempt && (row.current_submission_id !== submissionId || !["queued", "deferred"].includes(row.lifecycle_status)))
                continue;
            await applyDeliveryEvent(client, row.id, event, `${key}:${row.id}`, { attemptId: attempt?.id, projectLifecycle });
        }
    }
    async function routingFailure(client: OutboundRepositories, submission: Submission, code: string, message: string, retryable: boolean) {
        const count = (await client.routing.incrementDeferralCount({ id: submission.id })).rows[0].defer_count;
        const retry = retryable && count < 60;
        const error = diagnostic(code, message, code === "SENDER_NOT_AUTHORIZED" ? "authorization" : "routing", { retryable, retryDecision: retry ? { action: "scheduled", nextAttemptAt: new Date(Date.now() + 60000).toISOString() } : { action: "none", reason: retryable ? "routing_retries_exhausted" : "configuration_or_policy" } });
        await client.routing.setRoutingResult({ id: submission.id, status: retry ? "deferred" : "failed" });
        await emit(client, submission.id, retry ? "deferred" : "failed", `submission:${submission.id}:route:${count}`, error);
        if (retry)
            await enqueue(client, submission.id, 60);
    }
    async function prepareSubmission(submissionId: string): Promise<DeliverySubmission | {
        reconcileAttemptId: string;
    } | null> {
        return dependencies.unitOfWork.run(async (client) => {
            const owner = (await client.routing.findSubmissionOwner({ submissionId: submissionId })).rows[0];
            if (!owner)
                return null;
            let message = (await client.routing.lockSubmissionMessage({ messageId: owner.message_id })).rows[0];
            const submission = (await client.routing.lockSubmission({ submissionId: submissionId })).rows[0];
            const latest = submission.current_attempt_id ? (await client.routing.lockCurrentAttempt({ currentAttemptId: submission.current_attempt_id })).rows[0] : undefined;
            if (submission.status === "canceled")
                return null;
            if (latest?.status === "submitting") {
                if (!latest.submission_expired)
                    return null;
                const error = diagnostic("INTERRUPTED_SUBMISSION", "The submission deadline expired before its outcome was recorded.", "submission", { acceptance: "unknown", retryDecision: { action: "manual_review", reason: "Reconciliation will check provider acceptance; automatic resubmission is blocked." } });
                await client.routing.recordInterruptedAttempt({ id: latest.id, code: error.code, message: error.message, error: error });
                await client.routing.setInterruptedSubmission({ submissionId: submissionId });
                await emit(client, submissionId, "unknown", `attempt:${latest.id}:unknown`, error, latest);
                await enqueueReconciliation(client, latest.id, 30);
                return { reconcileAttemptId: latest.id };
            }
            if (latest && ["unknown", "reconciling"].includes(latest.status))
                return { reconcileAttemptId: latest.id };
            if (!["queued", "deferred"].includes(submission.status))
                return null;
            const all = await recipients(client, submissionId);
            const active = all.filter(row => row.current_submission_id === submissionId && ["queued", "deferred"].includes(row.lifecycle_status) && row.current_attempt_id === (latest?.id ?? null));
            if (!active.length) {
                await client.routing.cancelInactiveSubmission({ submissionId: submissionId });
                return null;
            }
            try {
                assertSendDeadline(message.send_before);
            }
            catch {
                await routingFailure(client, submission, DEADLINE_CODE, DEADLINE_MESSAGE, false);
                return null;
            }
            if (message.content_purged_at || !await client.authorizedDomain({ serviceId: message.service_id }, message.sender_snapshot.fromEmail)) {
                await routingFailure(client, submission, message.content_purged_at ? "CONTENT_EXPIRED" : "SENDER_NOT_AUTHORIZED", message.content_purged_at ? "The retained message content has expired." : "The sender authorization is no longer active.", false);
                return null;
            }
            message = dependencies.sendingContent(message);
            const allowed: Recipient[] = [];
            for (const recipient of active) {
                if (recipient.compliance_status !== "clean" || await isSuppressed(client, message.service_id, recipient.recipient_email, message.metadata.listId)) {
                    await applyDeliveryEvent(client, recipient.id, { id: createId("sup"), type: "suppressed", occurredAt: new Date(), metadata: {} }, `submission:${submissionId}:suppressed:${recipient.id}`);
                }
                else
                    allowed.push(recipient);
            }
            if (!allowed.length) {
                await client.routing.cancelSuppressedSubmission({ submissionId: submissionId });
                return null;
            }
            if (allowed.length !== all.length) {
                // A logical submission has an immutable envelope and provider idempotency key.
                // Fork when suppression, cancellation, or targeted retry changes its membership.
                await client.routing.cancelChangedEnvelope({ submissionId: submissionId });
                await createSubmission(client, message.id, allowed.map(row => row.id));
                return null;
            }
            const envelope = subsetEnvelope(message, allowed.map(row => ({ email: row.recipient_email, name: row.recipient_name ?? undefined })));
            const selected = (await client.routing.findBoundProvider({ sendingDomainId: message.sending_domain_id, serviceId: message.service_id })).rows[0];
            if (!selected) {
                await routingFailure(client, submission, "NO_ELIGIBLE_ROUTE", "No sending provider is bound to this service and domain.", false);
                return null;
            }
            if (capabilityIssue(message, dependencies.providerCapabilities(selected.provider_type), envelope)) {
                await routingFailure(client, submission, "UNSUPPORTED_MESSAGE_CAPABILITY", "The configured provider cannot preserve the message fields and recipient envelope.", false);
                return null;
            }
            if (evaluateCandidate(selected).length || !await reserveProviderCapacity(client, selected, allowed.length)) {
                await routingFailure(client, submission, "ROUTE_TEMPORARILY_UNAVAILABLE", "The configured provider is unavailable or has insufficient quota.", true);
                return null;
            }
            const attemptNumber = (latest?.attempt_number ?? 0) + 1;
            try {
                assertSendDeadline(message.send_before);
            }
            catch {
                await routingFailure(client, submission, DEADLINE_CODE, DEADLINE_MESSAGE, false);
                return null;
            }
            const attemptId = createId("att");
            const nativeIdempotency = dependencies.providerCapabilities(selected.provider_type).nativeIdempotency;
            const providerIdempotencyKey = nativeIdempotency ? `envoy/${submissionId}/${selected.provider_account_id}` : null;
            const canonical = { ...canonicalMessage(message, submissionId, envelope), rfcMessageId: `<${attemptId}@${message.sender_snapshot.fromEmail.split("@")[1]}>` };
            const fingerprintInput = JSON.stringify({ ...canonical, attachments: message.attachment_snapshot });
            const fingerprint = message.content_policy === "sensitive" ? dependencies.payloadDigest(fingerprintInput, `provider-request:${message.id}`, message.payload_hash_key_version ?? undefined).digest : createHash("sha256").update(fingerprintInput).digest("hex");
            const snapshot = {
                chosen: { accountId: selected.provider_account_id, identityId: selected.provider_identity_id, providerType: selected.provider_type, nativeIdempotency },
                selectedAt: new Date().toISOString(), recipientCount: allowed.length,
            };
            await client.routing.insertAttempt({ attemptId: attemptId, submissionId: submissionId, attemptNumber: attemptNumber, providerAccountId: selected.provider_account_id, providerIdentityId: selected.provider_identity_id, snapshot: snapshot, fingerprint: fingerprint, providerIdempotencyKey: providerIdempotencyKey });
            await client.routing.startSubmissionAttempt({ submissionId: submissionId, attemptId: attemptId });
            for (const row of allowed) {
                await client.routing.assignDeliveryAttempt({ id: row.id, attemptId: attemptId });
                await applyDeliveryEvent(client, row.id, { id: attemptId, type: "submitting", occurredAt: new Date(), metadata: {} }, `attempt:${attemptId}:${row.id}:submitting`, { attemptId, forceLifecycle: true });
            }
            await applySubmissionEvent(client, submissionId, { id: attemptId, type: "submitting", occurredAt: new Date(), metadata: {} }, `attempt:${attemptId}:submitting`, attemptId);
            return { attemptId, attemptNumber, submissionId, messageId: message.id, providerAccountId: selected.provider_account_id, providerIdentityId: selected.provider_identity_id, providerType: selected.provider_type, providerName: selected.provider_name, providerIdempotencyKey, requestFingerprint: fingerprint, routingSnapshot: snapshot, message: canonical, attachments: message.attachment_snapshot, sendBefore: message.send_before ?? null, sensitive: message.content_policy === "sensitive" };
        });
    }
    async function lockAttempt(client: OutboundRepositories, attemptId: string): Promise<Attempt | null> {
        const owner = (await client.routing.findAttemptOwner({ attemptId: attemptId })).rows[0];
        if (!owner)
            return null;
        await client.routing.lockAttemptMessage({ messageId: owner.message_id });
        await client.routing.lockAttemptSubmission({ submissionId: owner.submission_id });
        return (await client.routing.lockAttempt({ attemptId: attemptId })).rows[0] ?? null;
    }
    async function markAccepted(attemptId: string, externalMessageId: string, response: Record<string, unknown> = {}, rfcMessageId: string | null = null) {
        await dependencies.unitOfWork.run(async (client) => {
            const row = await lockAttempt(client, attemptId);
            if (!row || !["submitting", "unknown", "reconciling", "reconciled"].includes(row.status) || (row.status === "reconciled" && row.external_message_id))
                return;
            await client.routing.acceptAttempt({ attemptId: attemptId, externalMessageId: externalMessageId, responseJson: JSON.stringify(row.content_policy === "sensitive" ? {} : response), rfcMessageId: rfcMessageId });
            if (row.is_current)
                await client.routing.acceptSubmission({ submissionId: row.submission_id });
            await emit(client, row.submission_id, "accepted", `attempt:${attemptId}:accepted`, undefined, row, row.started_at);
        });
    }
    async function markUnknown(attemptId: string, message: string, details: {
        providerCode?: string;
        smtpStatus?: string;
        stage?: string;
    } = {}) {
        await dependencies.unitOfWork.run(async (client) => {
            const row = await lockAttempt(client, attemptId);
            if (!row || row.status !== "submitting")
                return;
            const error = diagnostic("SUBMISSION_OUTCOME_UNKNOWN", row.content_policy === "sensitive" ? "Provider submission outcome is unknown." : dependencies.safeDiagnostic(message), details.stage ?? "submission", { acceptance: "unknown", providerCode: row.content_policy === "sensitive" ? undefined : details.providerCode, smtpStatus: row.content_policy === "sensitive" ? undefined : details.smtpStatus, retryDecision: { action: "manual_review", reason: "Automatic resubmission is blocked until provider acceptance is determined." } });
            await client.routing.markAttemptUnknown({ attemptId: attemptId, code: error.code, message: error.message, error: error });
            if (row.is_current)
                await client.routing.markSubmissionUnknown({ submissionId: row.submission_id });
            await emit(client, row.submission_id, "unknown", `attempt:${attemptId}:unknown`, error, row);
            if (row.is_current)
                await enqueueReconciliation(client, attemptId, 30);
        });
    }
    async function markDeterminateFailure(attemptId: string, failure: {
        category: string;
        code: string;
        message: string;
        stage?: string;
        providerCode?: string;
        smtpStatus?: string;
    }, retryable: boolean) {
        return dependencies.unitOfWork.run(async (client) => {
            const row = await lockAttempt(client, attemptId);
            if (!row || row.status !== "submitting")
                return null;
            const expired = Boolean(row.send_before && row.send_before.getTime() <= Date.now());
            if (expired) {
                failure = { category: "policy", code: DEADLINE_CODE, message: DEADLINE_MESSAGE, stage: "submission" };
                retryable = false;
            }
            const retry = !expired && row.is_current && retryable && row.attempt_number < 5;
            const delay = Math.min(300, 5 * 2 ** (row.attempt_number - 1));
            const error = diagnostic(failure.code, row.content_policy === "sensitive" && !expired ? "Provider submission was not accepted." : dependencies.safeDiagnostic(failure.message), failure.stage ?? "submission", { retryable, acceptance: "not_accepted", providerCode: row.content_policy === "sensitive" ? undefined : failure.providerCode, smtpStatus: row.content_policy === "sensitive" ? undefined : failure.smtpStatus, retryDecision: retry ? { action: "scheduled", nextAttemptAt: new Date(Date.now() + delay * 1000).toISOString() } : { action: "none", reason: retryable ? "attempts_exhausted" : "not_retryable" } });
            await client.routing.failAttempt({ attemptId: attemptId, category: failure.category, code: error.code, message: error.message, error: error });
            if (row.is_current)
                await client.routing.setFailureResult({ submissionId: row.submission_id, status: retry ? "deferred" : "failed" });
            await emit(client, row.submission_id, retry ? "deferred" : "failed", `attempt:${attemptId}:failure`, error, row);
            if (retry)
                await enqueue(client, row.submission_id, delay);
            return row.submission_id;
        });
    }
    async function getAttemptForReconciliation(attemptId: string) {
        return (await dependencies.repositories.routing.claimReconciliation({ attemptId: attemptId })).rows[0] ?? null;
    }
    async function markReconciled(attemptId: string, outcome: "accepted" | "not_accepted" | "unknown") {
        await dependencies.unitOfWork.run(async (client) => {
            const row = await lockAttempt(client, attemptId);
            if (!row || !["unknown", "reconciling"].includes(row.status))
                return;
            if (outcome === "unknown") {
                const exhausted = row.reconciliation_count >= 12;
                await client.routing.recordUncertainReconciliation({ attemptId: attemptId, status: exhausted ? "unknown" : "reconciling", exhausted: exhausted });
                if (exhausted) {
                    const error = diagnostic("RECONCILIATION_EXHAUSTED", "Provider acceptance could not be determined after reconciliation. Review before authorizing a retry.", "reconciliation", { acceptance: "unknown", retryDecision: { action: "manual_review", reason: "reconciliation_exhausted" } });
                    await client.routing.recordReconciliationExhaustion({ attemptId: attemptId, error: error, code: error.code, message: error.message });
                    await emit(client, row.submission_id, "unknown", `attempt:${attemptId}:reconciliation_exhausted`, error, row);
                }
                else if (row.is_current)
                    await enqueueReconciliation(client, attemptId, 300);
                return;
            }
            const expired = Boolean(row.send_before && row.send_before.getTime() <= Date.now());
            const retry = !expired && outcome === "not_accepted" && row.is_current && row.attempt_number < 5;
            const error = outcome === "not_accepted" ? diagnostic(expired ? DEADLINE_CODE : "PROVIDER_NOT_ACCEPTED", expired ? DEADLINE_MESSAGE : "Reconciliation confirmed the provider did not accept the message.", "reconciliation", { retryable: !expired, retryDecision: retry ? { action: "scheduled", nextAttemptAt: new Date(Date.now() + 5000).toISOString() } : { action: "none", reason: expired ? "send_deadline_exceeded" : "attempts_exhausted" } }) : undefined;
            await client.routing.resolveAttemptReconciliation({ attemptId: attemptId, status: outcome === "accepted" ? "reconciled" : "failed", diagnostic: error ?? null });
            if (row.is_current)
                await client.routing.setReconciliationResult({ submissionId: row.submission_id, status: outcome === "accepted" ? "accepted" : retry ? "deferred" : "failed" });
            await emit(client, row.submission_id, outcome === "accepted" ? "accepted" : retry ? "deferred" : "failed", `attempt:${attemptId}:reconciled:${outcome}`, error, row, outcome === "accepted" ? row.started_at : new Date());
            if (retry)
                await enqueue(client, row.submission_id, 5);
        });
    }
    async function recordWorkflowFailure(submissionId: string, message: string) {
        await dependencies.unitOfWork.run(async (client) => {
            const owner = (await client.routing.findWorkflowOwner({ submissionId: submissionId })).rows[0];
            if (!owner)
                return;
            const content = (await client.routing.lockWorkflowContent({ messageId: owner.message_id })).rows[0];
            const row = (await client.routing.lockWorkflowSubmission({ submissionId: submissionId })).rows[0];
            if (!["queued", "deferred"].includes(row.status))
                return;
            const error = diagnostic("WORKFLOW_EXHAUSTED", content.content_policy === "sensitive" ? "Message workflow requires review." : dependencies.safeDiagnostic(message), "queue", { retryable: true, retryDecision: { action: "manual_review", reason: "The task exhausted infrastructure retries; retry the failed task or use the message retry API." } });
            await client.routing.deferWorkflow({ submissionId: submissionId });
            await emit(client, submissionId, "deferred", `submission:${submissionId}:workflow_exhausted`, error);
        });
    }
    return { prepareSubmission, markAccepted, markUnknown, markDeterminateFailure, getAttemptForReconciliation, markReconciled, recordWorkflowFailure };
}
