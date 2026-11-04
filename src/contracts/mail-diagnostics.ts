import { z } from "zod";

export const diagnosticCodes = ["MAILBOX_PERMANENTLY_REJECTED", "MAILBOX_TEMPORARILY_REJECTED", "DELIVERY_FAILED", "DELIVERY_DEFERRED", "RECIPIENT_SUPPRESSED", "PROVIDER_AUTHENTICATION_FAILED", "PROVIDER_RATE_LIMITED", "INVALID_RECIPIENT", "PROVIDER_POLICY_REJECTED", "PROVIDER_REJECTED", "PROVIDER_UNAVAILABLE", "PROVIDER_CONNECTION_UNAVAILABLE", "SUBMISSION_OUTCOME_UNKNOWN", "SUBMISSION_GUARD_REJECTED", "INTERRUPTED_SUBMISSION", "SEND_DEADLINE_EXCEEDED", "CONTENT_EXPIRED", "SENDER_NOT_AUTHORIZED", "NO_ELIGIBLE_ROUTE", "UNSUPPORTED_MESSAGE_CAPABILITY", "UNSUPPORTED_MAIL_FEATURE", "ROUTE_TEMPORARILY_UNAVAILABLE", "LOCAL_PREPARATION_FAILED", "RECONCILIATION_EXHAUSTED", "PROVIDER_NOT_ACCEPTED", "WORKFLOW_EXHAUSTED", "FILE_NOT_READY", "FILE_UNAVAILABLE", "UNCLASSIFIED_FAILURE", "VALIDATION_FAILED"] as const;
export const diagnosticReasons = ["MAILBOX_NOT_FOUND", "DOMAIN_INVALID", "MAILBOX_DISABLED", "MAILBOX_FULL", "MESSAGE_TOO_LARGE", "CONTENT_REJECTED", "ATTACHMENT_REJECTED", "RECIPIENT_SUPPRESSED", "PROVIDER_QUOTA_EXCEEDED", "PROVIDER_RATE_LIMITED", "PROVIDER_AUTH_FAILED", "PROVIDER_PERMISSION_DENIED", "SENDER_NOT_VERIFIED", "INVALID_RECIPIENT", "PROVIDER_REQUEST_INVALID"] as const;
export const diagnosticStages = ["PREPARATION", "AUTHORIZATION", "ROUTING", "SUBMISSION", "RECIPIENT_DELIVERY", "RECONCILIATION", "QUEUE", "POLICY", "OBSERVATION"] as const;
export const suppressionReasons = ["HARD_BOUNCE", "COMPLAINED", "PROVIDER_SUPPRESSED", "SOFT_BOUNCE_THRESHOLD", "UNSUBSCRIBE", "MANUAL"] as const;
export const enhancedStatusPattern = /^[245]\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})$/;
export const diagnosticEvidenceSchema = z.object({
  smtpReplyCode: z.number().int().min(400).max(599).optional(),
  smtpStatus: z.string().regex(enhancedStatusPattern).optional(),
  bounceClass: z.enum(["HARD", "SOFT", "UNKNOWN"]).optional(),
  suppressionReason: z.enum(suppressionReasons).optional(),
}).strict();
export const mailDiagnosticSchema = z.object({
  source: z.enum(["MORPH", "ENVOY", "PROVIDER"]), code: z.enum(diagnosticCodes),
  reasonCode: z.enum(diagnosticReasons).nullable(), stage: z.enum(diagnosticStages),
  detailAvailability: z.enum(["SPECIFIC", "CATEGORY_ONLY", "NOT_RECORDED", "PROVIDER_NOT_SUPPLIED"]),
  evidence: diagnosticEvidenceSchema, occurredAt: z.iso.datetime({ offset: true }).nullable(),
}).strict().superRefine((value,context)=>{
  if ((value.detailAvailability === "SPECIFIC") !== (value.reasonCode !== null)) context.addIssue({code:"custom",path:["detailAvailability"],message:"Specific detail requires a known reasonCode"});
});
export const retryDispositionSchema = z.object({
  owner: z.enum(["ENVOY", "PROVIDER", "NONE", "UNKNOWN"]),
  action: z.enum(["SCHEDULED", "WAITING_PROVIDER", "STOPPED", "MANUAL_REVIEW"]),
  nextAttemptAt: z.iso.datetime({ offset: true }).nullable(),
}).strict().superRefine((value,context)=>{
  const valid = value.owner === "ENVOY" ? ["SCHEDULED","MANUAL_REVIEW"].includes(value.action) : value.owner === "PROVIDER" ? value.action === "WAITING_PROVIDER" : value.owner === "NONE" ? value.action === "STOPPED" : value.action === "MANUAL_REVIEW";
  if (!valid || (value.nextAttemptAt !== null && value.action !== "SCHEDULED")) context.addIssue({code:"custom",message:"Retry responsibility and action must describe the same disposition"});
});
export type MailDiagnostic = z.infer<typeof mailDiagnosticSchema>;
export type DiagnosticReason = z.infer<typeof mailDiagnosticSchema>["reasonCode"];
export type DiagnosticEvidence = z.infer<typeof diagnosticEvidenceSchema>;
export type RetryDisposition = z.infer<typeof retryDispositionSchema>;
export function projectDiagnostic(value: unknown): MailDiagnostic | null {
  if (value === null || value === undefined) return null;
  return mailDiagnosticSchema.parse(value);
}
export const stoppedRetry: RetryDisposition = { owner: "NONE", action: "STOPPED", nextAttemptAt: null };
export const deliverySnapshotSchema = z.object({
  id: z.string(), messageId: z.string(), revision: z.string().regex(/^[1-9][0-9]*$/),
  submissionId: z.string().nullable(), attemptId: z.string().nullable(),
  lifecycle: z.enum(["queued", "submitting", "accepted", "deferred", "delivered", "bounced", "failed", "unknown", "canceled"]),
  outcome: z.enum(["pending", "succeeded", "failed", "canceled", "unknown"]),
  acceptedAt: z.iso.datetime({ offset: true }).nullable(), deliveredAt: z.iso.datetime({ offset: true }).nullable(),
  diagnostic: mailDiagnosticSchema.nullable(), retryDisposition: retryDispositionSchema,
  observedAt: z.iso.datetime({ offset: true }),
}).strict();
export type DeliverySnapshot = z.infer<typeof deliverySnapshotSchema>;
