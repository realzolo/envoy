import type { CanonicalEvent, CanonicalMessage, EmailAddress, ProviderType } from "@/integrations/providers/contracts";
export type StoredAttachment = {
    fileId: string;
    fileName: string;
    contentType: string;
    size: number;
    sha256: string;
    objectKey: string;
    disposition: "attachment" | "inline";
    contentId: string | null;
};
export type MessageContent = {
    id: string;
    service_id: string;
    sending_domain_id: string;
    sender_snapshot: {
        service: string;
        fromName?: string;
        fromEmail: string;
        domainId: string;
    };
    to_recipients: EmailAddress[];
    cc_recipients: EmailAddress[];
    bcc_recipients: EmailAddress[];
    reply_to: EmailAddress[];
    subject: string;
    html_body: string | null;
    text_body: string | null;
    headers: Record<string, string>;
    in_reply_to: string | null;
    references_ids: string[];
    attachment_snapshot: StoredAttachment[];
    provider_tags: Record<string, string>;
    message_category: string;
    content_purged_at: Date | null;
    metadata: Record<string, string>;
    content_policy?: "normal" | "sensitive";
    send_before?: Date | null;
    payload_hash_key_version?: string | null;
    sensitive_content?: import("@/platform/crypto/envelope").Envelope | null;
    sensitive_content_purged_at?: Date | null;
};
export type MessageRow = MessageContent & {
    request_id: string | null;
    accepted_at: Date;
    recipient_count: number;
    reference_id: string | null;
    service: string;
    category: string;
    counts: Record<string, number>;
    processing_state: "queued" | "processing" | "finished";
    outcome: "pending" | "succeeded" | "partially_failed" | "failed" | "canceled" | "unknown";
    cursor_at: string;
};
export type RetryOptions = {
    acknowledgeUnknown: boolean;
    actor: string;
};
export type DeliveryStateEvent = Omit<CanonicalEvent, "type"> & {
    type: CanonicalEvent["type"] | "queued" | "submitting" | "unknown" | "canceled";
};
export type Candidate = {
    provider_account_id: string;
    provider_identity_id: string;
    provider_type: ProviderType;
    provider_name: string;
    domain: string;
    account_status: string;
    health: Record<string, unknown>;
    identity_status: string;
    domain_status: string;
};
export type DeliverySubmission = {
    attemptId: string;
    attemptNumber: number;
    submissionId: string;
    messageId: string;
    providerAccountId: string;
    providerIdentityId: string;
    providerType: ProviderType;
    providerName: string;
    providerIdempotencyKey: string | null;
    requestFingerprint: string;
    routingSnapshot: Record<string, unknown>;
    message: CanonicalMessage;
    attachments: StoredAttachment[];
    sendBefore: Date | null;
    sensitive: boolean;
};
export type Submission = {
    id: string;
    message_id: string;
    status: string;
    current_attempt_id: string | null;
    defer_count: number;
};
export type Attempt = {
    id: string;
    submission_id: string;
    status: string;
    external_message_id: string | null;
    attempt_number: number;
    routing_snapshot: Record<string, unknown>;
    started_at: Date;
    reconciliation_count: number;
    retry_authorized_at: Date | null;
    is_current: boolean;
    submission_expired: boolean;
    content_policy: string;
    send_before: Date | null;
};
export type Recipient = {
    id: string;
    recipient_email: string;
    recipient_name: string | null;
    lifecycle_status: string;
    compliance_status: string;
    current_attempt_id: string | null;
    current_submission_id: string | null;
};
export interface RawProviderReceipt {
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
}
