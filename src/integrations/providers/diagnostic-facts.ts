import { diagnosticReasons, enhancedStatusPattern, type DiagnosticEvidence, type DiagnosticReason } from "@/contracts/mail-diagnostics";
const MAX_DIAGNOSTIC_VALUES = 20;
const MAX_DIAGNOSTIC_LENGTH = 2000;
const reasonByStatus: Record<string, DiagnosticReason> = { "5.1.1": "MAILBOX_NOT_FOUND", "5.1.2": "DOMAIN_INVALID", "4.2.1": "MAILBOX_DISABLED", "5.2.1": "MAILBOX_DISABLED", "4.2.2": "MAILBOX_FULL", "5.2.2": "MAILBOX_FULL", "5.2.3": "MESSAGE_TOO_LARGE", "5.3.4": "MESSAGE_TOO_LARGE" };
const subtypeReasons: Record<string, DiagnosticReason> = { MailboxFull: "MAILBOX_FULL", MessageTooLarge: "MESSAGE_TOO_LARGE", ContentRejected: "CONTENT_REJECTED", AttachmentRejected: "ATTACHMENT_REJECTED", Suppressed: "RECIPIENT_SUPPRESSED" };
export function smtpFacts(values: unknown[]): { reasonCode: DiagnosticReason; evidence: DiagnosticEvidence } {
    const texts = values.slice(0, MAX_DIAGNOSTIC_VALUES).filter((value): value is string => typeof value === "string").map(value => value.slice(0, MAX_DIAGNOSTIC_LENGTH));
    const statuses = [...new Set(texts.flatMap(value => value.match(/(?<![\w.])[245]\.[0-9]{1,3}\.[0-9]{1,3}(?![\w.])/g) ?? []).filter(value => enhancedStatusPattern.test(value)))];
    const replies = [...new Set(texts.flatMap(value => [...value.matchAll(/(?:^|[\r\n]|smtp;)\s*([45][0-9]{2})(?=[ -])/gi)].map(match=>match[1])))];
    const evidence: DiagnosticEvidence = { ...(statuses.length === 1 ? { smtpStatus: statuses[0] } : {}), ...(replies.length === 1 ? { smtpReplyCode: Number(replies[0]) } : {}) };
    return { reasonCode: statuses.length === 1 ? reasonByStatus[statuses[0]] ?? null : null, evidence };
}
export function resendBounceFacts(bounce: { type?: unknown; subType?: unknown; diagnosticCode?: unknown; message?: unknown }) {
    const facts = smtpFacts([...(Array.isArray(bounce.diagnosticCode) ? bounce.diagnosticCode : []), bounce.message]);
    const subtype = typeof bounce.subType === "string" ? subtypeReasons[bounce.subType] : undefined;
    const reasonCode = subtype && facts.reasonCode && subtype !== facts.reasonCode ? null : subtype ?? facts.reasonCode;
    return { reasonCode, evidence: { ...facts.evidence, bounceClass: bounce.type === "Permanent" ? "HARD" as const : bounce.type === "Transient" || bounce.type === "Temporary" ? "SOFT" as const : "UNKNOWN" as const } };
}
/** Only fixed machine codes are interpreted. Provider free text never enters this result. */
export function submissionReason(code: unknown, httpStatus?: number): DiagnosticReason {
    const known: Record<string, DiagnosticReason> = { reached_daily_quota: "PROVIDER_QUOTA_EXCEEDED", daily_quota_exceeded: "PROVIDER_QUOTA_EXCEEDED", monthly_quota_exceeded: "PROVIDER_QUOTA_EXCEEDED", sending_quota_exceeded: "PROVIDER_QUOTA_EXCEEDED", rate_limit_exceeded: "PROVIDER_RATE_LIMITED", invalid_api_key: "PROVIDER_AUTH_FAILED", missing_api_key: "PROVIDER_AUTH_FAILED", restricted_api_key: "PROVIDER_PERMISSION_DENIED", validation_error: "PROVIDER_REQUEST_INVALID", invalid_from_address: "SENDER_NOT_VERIFIED", unverified_domain: "SENDER_NOT_VERIFIED" };
    return typeof code === "string" && known[code] ? known[code] : httpStatus === 401 ? "PROVIDER_AUTH_FAILED" : httpStatus === 429 ? "PROVIDER_RATE_LIMITED" : null;
}
export function safeReason(value: unknown): DiagnosticReason { return typeof value === "string" && diagnosticReasons.includes(value as NonNullable<DiagnosticReason>) ? value as DiagnosticReason : null; }
