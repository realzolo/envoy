import type { CanonicalEvent, CanonicalEventType, ProviderType } from "@/integrations/providers/contracts";
import type { Attempt, Candidate, DeliveryStateEvent, MessageContent, MessageRow, Recipient, SimulationRow, Submission } from "../contracts";
import type { Diagnostic } from "../domain/diagnostics";
export type RepositoryResult<Row> = {
    rows: Row[];
    rowCount: number | null;
};
export interface MessageRepository {
    isRecipientSuppressed(input: {
        email: string;
        productId: string;
        listId: string | null;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    findConfiguredProviderTypes(input: {
        sendingDomainId: string;
        productId: string;
        serviceId: string;
        messageCategory: string;
    }): Promise<RepositoryResult<{
        type: ProviderType;
    }>>;
    insertSubmission(input: {
        id: string;
        messageId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    insertSubmissionRecipients(input: {
        id: string;
        deliveryIds: string[];
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    assignSubmissionToDeliveries(input: {
        id: string;
        deliveryIds: string[];
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    enqueueSubmission(input: {
        outboxId: string;
        submissionId: string;
        payload: {
            submissionId: string;
        };
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    lockIdempotencyKey(input: {
        lockKey: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    findIdempotentMessage(input: {
        serviceId: string;
        idempotencyKey: string;
    }): Promise<RepositoryResult<{
        id: string;
        payload_hash: string;
        payload_hash_key_version: string | null;
        accepted_at: Date;
        product: string;
        message_category: string;
        recipient_count: number;
        reference_id: string | null;
    }>>;
    insertMessage(input: {
        content: MessageContent;
        recipientCount: number;
        requestId: string | null;
        idempotencyKey: string;
        payloadHash: string;
        referenceId: string | null;
        keyVersion: string | null;
    }): Promise<RepositoryResult<{
        accepted_at: Date;
    }>>;
    insertDelivery(input: {
        deliveryId: string;
        messageId: string;
        email: string;
        recipientName: string | null;
        role: "to" | "cc" | "bcc";
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    listAuthorizedMessages(input: {
        serviceId: string;
        referenceId: string | null;
        at: string | Date | null;
        relatedId: string | null;
        processingState: string | null;
        outcome: string | null;
        limit: number;
    }): Promise<RepositoryResult<MessageRow>>;
    findAuthorizedMessage(input: {
        id: string;
        serviceId: string;
    }): Promise<RepositoryResult<MessageRow>>;
    listMessageDeliveries(input: {
        id: string;
    }): Promise<RepositoryResult<{
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
    }>>;
    lockAuthorizedMessage(input: {
        id: string;
        serviceId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    lockMessageSubmissions(input: {
        id: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    lockCancelableDeliveries(input: {
        id: string;
    }): Promise<RepositoryResult<{
        id: string;
    }>>;
    cancelEmptySubmissions(input: {
        id: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    lockDeliveryRetryState(input: {
        deliveryId: string;
    }): Promise<RepositoryResult<{
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
    }>>;
    lockDeliveryMessage(input: {
        deliveryId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    lockRetryMessage(input: {
        id: string;
        serviceId: string;
    }): Promise<RepositoryResult<MessageContent>>;
    findRetryReceipt(input: {
        id: string;
        idempotencyKey: string;
    }): Promise<RepositoryResult<{
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
    }>>;
    lockRetrySubmissions(input: {
        id: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    listRetryRecipients(input: {
        id: string;
    }): Promise<RepositoryResult<{
        id: string;
        recipient_email: string;
        recipient_name: string | null;
    }>>;
    authorizeAttemptRetry(input: {
        currentAttemptId: string;
        actor: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
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
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    findDeliveryOwner(input: {
        deliveryId: string;
    }): Promise<RepositoryResult<{
        id: string;
        service_id: string;
    }>>;
}
export interface EventsRepository {
    findCallbackMessage(input: {
        messageId: string;
        serviceId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    listSubscribedEndpoints(input: {
        serviceId: string;
        type: string;
    }): Promise<RepositoryResult<{
        id: string;
    }>>;
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
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    enqueueCallback(input: {
        outboxId: string;
        callbackDeliveryId: string;
        payload: {
            callbackDeliveryId: string;
        };
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    insertGlobalSuppression(input: {
        suppressionId: string;
        recipientEmail: string;
        reason: "suppressed" | "complained" | "hard_bounce";
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    insertUnsubscribeSuppression(input: {
        suppressionId: string;
        scope: "list" | "product";
        productId: string;
        listId: string | null;
        recipientEmail: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    countRecentSoftBounces(input: {
        recipientEmail: string;
    }): Promise<RepositoryResult<{
        count: string;
    }>>;
    insertSoftBounceSuppression(input: {
        suppressionId: string;
        recipientEmail: string;
        bounceCount: number;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    lockDeliveryState(input: {
        deliveryId: string;
    }): Promise<RepositoryResult<{
        current_attempt_id: string | null;
        current_submission_id: string | null;
        lifecycle_status: string;
    }>>;
    findDeliveryContentPolicy(input: {
        deliveryId: string;
    }): Promise<RepositoryResult<{
        content_policy: string;
    }>>;
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
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    findAttemptSubmission(input: {
        attemptId: string;
    }): Promise<RepositoryResult<{
        submission_id: string;
    }>>;
    restoreConclusiveAttempt(input: {
        deliveryId: string;
        attemptId: string;
        attemptSubmission: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    findLatestLifecycleEvent(input: {
        deliveryId: string;
        eventId: string;
        lifecycleTypes: string[];
        attemptId: string | null;
    }): Promise<RepositoryResult<{
        event_type: string;
        occurred_at: Date;
    }>>;
    projectLifecycle(input: {
        deliveryId: string;
        type: "unknown" | "submitting" | CanonicalEventType | "queued" | "canceled";
        occurredAt: Date;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    projectEngagement(input: {
        deliveryId: string;
        type: "opened" | "clicked";
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    projectCompliance(input: {
        deliveryId: string;
        type: "unknown" | "submitting" | CanonicalEventType | "queued" | "canceled";
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    failSuppressedDelivery(input: {
        deliveryId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    recordDeliveryDiagnostic(input: {
        deliveryId: string;
        error: Diagnostic;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    clearDeliveryDiagnostic(input: {
        deliveryId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    findDeliveryCallbackContext(input: {
        deliveryId: string;
    }): Promise<RepositoryResult<{
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
    }>>;
    findSubmissionContentPolicy(input: {
        submissionId: string;
    }): Promise<RepositoryResult<{
        content_policy: string;
    }>>;
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
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    findSubmissionOwner(input: {
        submissionId: string;
    }): Promise<RepositoryResult<{
        id: string;
        service_id: string;
        request_id: string | null;
        reference_id: string | null;
    }>>;
    findProviderAttempt(input: {
        providerAccountId: string;
        externalMessageId: string | undefined;
    }): Promise<RepositoryResult<{
        id: string;
        submission_id: string;
        message_id: string;
    }>>;
    lockEventMessage(input: {
        messageId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    lockEventSubmission(input: {
        submissionId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    lockEventAttempt(input: {
        id: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    listEventRecipients(input: {
        submissionId: string;
        recipient: string | null;
    }): Promise<RepositoryResult<{
        id: string;
    }>>;
    resolveVerifiedAcceptance(input: {
        id: string;
    }): Promise<RepositoryResult<{
        started_at: Date;
    }>>;
    acceptCurrentSubmission(input: {
        submissionId: string;
        relatedId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    listSubmissionRecipients(input: {
        submissionId: string;
    }): Promise<RepositoryResult<{
        id: string;
    }>>;
    claimProviderEvent(input: {
        rawEventId: string;
    }): Promise<RepositoryResult<{
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
    }>>;
    saveNormalizedFacts(input: {
        id: string;
        factsJson: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    completeProviderEvent(input: {
        id: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    lockProviderReceipt(input: {
        id: string;
    }): Promise<RepositoryResult<{
        raw_object_key: string | null;
        receipt_object_key: string | null;
    }>>;
    enqueueObjectDeletion(input: {
        key: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    completeAndPurgeProviderReceipt(input: {
        id: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    rejectInboundReceipt(input: {
        id: string;
        message: "Inbound event processing was rejected." | "Provider event processing failed; durable verified receipt/facts retained for retry.";
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    deferProviderEvent(input: {
        id: string;
        message: "Inbound event processing was rejected." | "Provider event processing failed; durable verified receipt/facts retained for retry.";
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    enqueueProviderEvent(input: {
        outboxId: string;
        rawEventId: string;
        eventType: string;
        payload: {
            rawEventId: string;
        };
    }): Promise<RepositoryResult<Record<string, unknown>>>;
}
export interface RoutingRepository {
    lockAccountQuota(input: {
        providerAccountId: string;
    }): Promise<RepositoryResult<{
        quota: Record<string, unknown>;
    }>>;
    readAccountUsage(input: {
        providerAccountId: string;
    }): Promise<RepositoryResult<{
        monthly: string;
        daily: string;
    }>>;
    lockSubmissionRecipients(input: {
        submissionId: string;
    }): Promise<RepositoryResult<Recipient>>;
    enqueueSubmission(input: {
        outboxId: string;
        submissionId: string;
        payload: {
            submissionId: string;
        };
        seconds: number;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    enqueueReconciliation(input: {
        outboxId: string;
        attemptId: string;
        payload: {
            attemptId: string;
        };
        seconds: number;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    incrementDeferralCount(input: {
        id: string;
    }): Promise<RepositoryResult<{
        defer_count: number;
    }>>;
    setRoutingResult(input: {
        id: string;
        status: "failed" | "deferred";
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    findSubmissionOwner(input: {
        submissionId: string;
    }): Promise<RepositoryResult<{
        message_id: string;
    }>>;
    lockSubmissionMessage(input: {
        messageId: string;
    }): Promise<RepositoryResult<MessageContent>>;
    lockSubmission(input: {
        submissionId: string;
    }): Promise<RepositoryResult<Submission>>;
    lockCurrentAttempt(input: {
        currentAttemptId: string;
    }): Promise<RepositoryResult<Attempt>>;
    recordInterruptedAttempt(input: {
        id: string;
        code: string;
        message: string;
        error: Diagnostic;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    setInterruptedSubmission(input: {
        submissionId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    cancelInactiveSubmission(input: {
        submissionId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    cancelSuppressedSubmission(input: {
        submissionId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    cancelChangedEnvelope(input: {
        submissionId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    listRoutingCandidates(input: {
        sendingDomainId: string;
        productId: string;
        serviceId: string;
        messageCategory: string;
    }): Promise<RepositoryResult<Candidate>>;
    listFailedAccounts(input: {
        submissionId: string;
    }): Promise<RepositoryResult<{
        provider_account_id: string;
    }>>;
    beginCapacityReservation(): Promise<RepositoryResult<Record<string, unknown>>>;
    commitCapacityReservation(): Promise<RepositoryResult<Record<string, unknown>>>;
    rollbackCapacityReservation(): Promise<RepositoryResult<Record<string, unknown>>>;
    releaseCapacityReservation(): Promise<RepositoryResult<Record<string, unknown>>>;
    closeExpiredCircuit(input: {
        targetId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
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
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    startSubmissionAttempt(input: {
        submissionId: string;
        attemptId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    assignDeliveryAttempt(input: {
        id: string;
        attemptId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    findAttemptOwner(input: {
        attemptId: string;
    }): Promise<RepositoryResult<{
        submission_id: string;
        message_id: string;
    }>>;
    lockAttemptMessage(input: {
        messageId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    lockAttemptSubmission(input: {
        submissionId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    lockAttempt(input: {
        attemptId: string;
    }): Promise<RepositoryResult<Attempt>>;
    acceptAttempt(input: {
        attemptId: string;
        externalMessageId: string;
        responseJson: string;
        rfcMessageId: string | null;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    acceptSubmission(input: {
        submissionId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    resetCircuit(input: {
        targetId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    markAttemptUnknown(input: {
        attemptId: string;
        code: string;
        message: string;
        error: Diagnostic;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    markSubmissionUnknown(input: {
        submissionId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    failAttempt(input: {
        attemptId: string;
        category: string;
        code: string;
        message: string;
        error: Diagnostic;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    setFailureResult(input: {
        submissionId: string;
        status: "failed" | "deferred";
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    readCircuitFailureWindow(input: {
        targetId: string;
        categories: string[];
        threshold: number;
    }): Promise<RepositoryResult<{
        sample_count: string;
        all_failed: boolean;
    }>>;
    openCircuit(input: {
        targetId: string;
        seconds: number;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    claimReconciliation(input: {
        attemptId: string;
    }): Promise<RepositoryResult<{
        id: string;
        submission_id: string;
        provider_account_id: string;
        external_message_id: string | null;
        request_fingerprint: string;
        status: string;
    }>>;
    recordUncertainReconciliation(input: {
        attemptId: string;
        status: "unknown" | "reconciling";
        exhausted: boolean;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    recordReconciliationExhaustion(input: {
        attemptId: string;
        error: Diagnostic;
        code: string;
        message: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    resolveAttemptReconciliation(input: {
        attemptId: string;
        status: "failed" | "reconciled";
        diagnostic: Diagnostic | null;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    setReconciliationResult(input: {
        submissionId: string;
        status: "failed" | "deferred" | "accepted";
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    findWorkflowOwner(input: {
        submissionId: string;
    }): Promise<RepositoryResult<{
        message_id: string;
    }>>;
    lockWorkflowContent(input: {
        messageId: string;
    }): Promise<RepositoryResult<{
        content_policy: string;
    }>>;
    lockWorkflowSubmission(input: {
        submissionId: string;
    }): Promise<RepositoryResult<Submission>>;
    deferWorkflow(input: {
        submissionId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
}
export interface OutboundRepositories {
    management: ManagementRepository;
    message: MessageRepository;
    events: EventsRepository;
    routing: RoutingRepository;
    authorizedDomain(identity: {
        productId: string;
        serviceId: string;
    }, email: string): Promise<string | null>;
    resolveOutboundAttachments(serviceId: string, attachments: import("@/lib/contracts").CreateMessageInput["attachments"], domainId: string): Promise<import("../contracts").StoredAttachment[]>;
    reserveRateLimits(entries: {
        scope: string;
        key: string;
        limit: number;
        units?: number;
    }[]): Promise<boolean>;
}
export interface EventOperations {
    applyDeliveryEvent(repositories: OutboundRepositories, deliveryId: string, event: DeliveryStateEvent, sourceKey: string, options?: {
        rawEventId?: string | null;
        attemptId?: string;
        forceLifecycle?: boolean;
        providerEvent?: boolean;
        projectLifecycle?: boolean;
    }): Promise<boolean>;
    applySubmissionEvent(repositories: OutboundRepositories, submissionId: string, event: DeliveryStateEvent, sourceKey: string, attemptId?: string, rawEventId?: string | null): Promise<boolean>;
}
export interface MessageOperations {
    createSubmission(repositories: OutboundRepositories, messageId: string, deliveryIds: string[]): Promise<string | null>;
    isSuppressed(repositories: OutboundRepositories, productId: string, email: string, listId?: string): Promise<boolean>;
}
export interface OutboundDependencies {
    safeDiagnostic(value: unknown): string;
    unitOfWork: import("@/platform/transactions").UnitOfWork<OutboundRepositories>;
    repositories: OutboundRepositories;
    payloadDigest(value: string, context: string, keyVersion?: string): {
        digest: string;
        keyVersion: string;
    };
    providerEvents: {
        decode(raw: import("../contracts").RawProviderReceipt): Promise<{
            events: CanonicalEvent[];
            receiveInbound(): Promise<boolean>;
        }>;
        isTerminal(error: unknown): boolean;
    };
    providerCapabilities(type: ProviderType): import("@/integrations/providers/contracts").ProviderCapabilities;
    persistedContent(content: MessageContent): MessageContent;
    sendingContent(content: MessageContent): MessageContent;
    events: EventOperations;
    messages: MessageOperations;
}
export interface ManagementRepository {
    recordAudit(input: {
        actor: string;
        action: string;
        resourceType: string;
        resourceId: string | null;
        details: Record<string, unknown>;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    findService(input: {
        serviceId: string;
    }): Promise<RepositoryResult<{
        product_id: string;
    }>>;
    findProduct(input: {
        productId: string;
    }): Promise<RepositoryResult<{
        id: string;
    }>>;
    findDomain(input: {
        domainId: string;
    }): Promise<RepositoryResult<{
        id: string;
        status: string;
    }>>;
    listTargetIdentities(input: {
        identityIds: string[];
    }): Promise<RepositoryResult<{
        id: string;
        sending_domain_id: string;
        provider_account_id: string;
        status: string;
        account_status: string;
    }>>;
    lockPolicy(input: {
        policyId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    deleteTargets(input: {
        policyId: string;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    updatePolicy(input: {
        id: string;
        name: string;
        productId: string | null;
        serviceId: string | null;
        domainId: string;
        category: string | null;
        priority: number;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    insertPolicy(input: {
        id: string;
        name: string;
        productId: string | null;
        serviceId: string | null;
        domainId: string;
        category: string | null;
        priority: number;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    insertTarget(input: {
        id: string;
        policyId: string;
        accountId: string;
        identityId: string;
        priority: number;
        weight: number;
        rateLimit: number;
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    recordPolicyAudit(input: {
        actor: string;
        policyId: string;
        details: {
            productId: string | null;
            serviceId: string | null;
            domainId: string;
            category: string | null;
            priority: number;
            targetCount: number;
        };
        action: "routing_policy.update" | "routing_policy.create";
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    setPolicyStatus(input: {
        policyId: string;
        status: "active" | "disabled";
    }): Promise<RepositoryResult<Record<string, unknown>>>;
    listSimulationCandidates(input: {
        domainId: string;
        productId: string | null;
        serviceId: string | null;
        category: string | null;
    }): Promise<RepositoryResult<SimulationRow>>;
    findTestService(input: {
        serviceId: string;
    }): Promise<RepositoryResult<{
        service_id: string;
        service_name: string;
        product_id: string;
        product_name: string;
    }>>;
}
