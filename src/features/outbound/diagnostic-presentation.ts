import type { MailDiagnostic, RetryDisposition } from "@/contracts/mail-diagnostics";
import type { DeliveryStatus, EmailRecord } from "@/lib/types";

export function eventLabel(type: string) {
  return type === "identity_confirmed" ? "Message identity confirmed"
    : type.replace(/[_.]/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

const reasons: Record<NonNullable<MailDiagnostic["reasonCode"]>, [string, string]> = {
  MAILBOX_NOT_FOUND: ["Recipient mailbox does not exist", "Verify the recipient address before starting a new send through your application."],
  DOMAIN_INVALID: ["Recipient domain cannot receive mail", "Check the domain spelling and ask the recipient to confirm its mail configuration."],
  MAILBOX_DISABLED: ["Recipient mailbox is disabled", "Ask the recipient to enable the mailbox or provide another address."],
  MAILBOX_FULL: ["Recipient mailbox is full", "Ask the recipient to free up space before starting a new send through your application."],
  MESSAGE_TOO_LARGE: ["Message exceeds the size limit", "Reduce the message body or attachment size."],
  CONTENT_REJECTED: ["Recipient policy rejected the content", "Review the message content and confirm the recipient's content policy."],
  ATTACHMENT_REJECTED: ["Recipient policy rejected an attachment", "Check the attachment type and size."],
  RECIPIENT_SUPPRESSED: ["Recipient is suppressed", "Review the suppression source. Viewing diagnostics does not remove the suppression."],
  PROVIDER_QUOTA_EXCEEDED: ["Provider sending quota exceeded", "Check the provider's sending quota and account status."],
  PROVIDER_RATE_LIMITED: ["Provider rate limit reached", "Review who is responsible for further processing and the current schedule."],
  PROVIDER_AUTH_FAILED: ["Provider authentication failed", "Check the current provider credentials."],
  PROVIDER_PERMISSION_DENIED: ["Provider permission denied", "Check the provider account permissions."],
  SENDER_NOT_VERIFIED: ["Sender identity is not verified", "Check the sending domain and its verification status with the provider."],
  INVALID_RECIPIENT: ["Recipient address format is invalid", "Check the complete recipient address."],
  PROVIDER_REQUEST_INVALID: ["Provider rejected the request parameters", "Check the sending parameters against the provider's requirements."],
};

const classes: Record<MailDiagnostic["code"], [string, string]> = {
  MAILBOX_PERMANENTLY_REJECTED: ["Recipient permanently rejected delivery", "A permanent rejection alone does not prove the mailbox is missing. Check the recipient address and mail configuration."],
  MAILBOX_TEMPORARILY_REJECTED: ["Delivery bounced after a temporary rejection", "This delivery has ended. Resolve the recipient's mail issue before starting a new send through your application."],
  DELIVERY_DEFERRED: ["Delivery is deferred", "The provider is still processing this delivery. Wait for the final result."],
  DELIVERY_FAILED: ["Delivery failed", "Review the recorded evidence and check the recipient's mail service and provider status."],
  RECIPIENT_SUPPRESSED: reasons.RECIPIENT_SUPPRESSED,
  PROVIDER_RATE_LIMITED: reasons.PROVIDER_RATE_LIMITED,
  PROVIDER_AUTHENTICATION_FAILED: reasons.PROVIDER_AUTH_FAILED,
  INVALID_RECIPIENT: reasons.INVALID_RECIPIENT,
  PROVIDER_POLICY_REJECTED: ["Provider policy rejected submission", "Check the provider's sending policy, sender identity, and recipient restrictions."],
  PROVIDER_REJECTED: ["Provider rejected submission", "Only the rejection category is known. Review the provider account and the original message record."],
  PROVIDER_UNAVAILABLE: ["Provider is temporarily unavailable", "Check the provider service and account status, and follow the original request's processing schedule."],
  PROVIDER_CONNECTION_UNAVAILABLE: ["Could not connect to the provider before submission", "Check the sending route's network connection and provider service."],
  SUBMISSION_GUARD_REJECTED: ["Submission requirements were not met", "Check the current sending permissions, route, and processing requirements."],
  INTERRUPTED_SUBMISSION: ["Message submission was interrupted", "Check the original submission before sending again to avoid a duplicate."],
  NO_ELIGIBLE_ROUTE: ["No eligible sending route", "Check this Service's sending domain permissions and provider sender identity."],
  UNSUPPORTED_MESSAGE_CAPABILITY: ["The sending route does not support this message", "Check the message format, attachments, and route capabilities."],
  UNSUPPORTED_MAIL_FEATURE: ["The sending route does not support this feature", "Check the requested mail feature against the provider route's capabilities."],
  ROUTE_TEMPORARILY_UNAVAILABLE: ["Sending route is temporarily unavailable", "Wait for the original request's scheduled processing and check the route status."],
  LOCAL_PREPARATION_FAILED: ["Message preparation failed", "Check attachments, sender configuration, and the original task. A specific cause was not recorded."],
  PROVIDER_NOT_ACCEPTED: ["Provider did not accept submission", "Review the original request's processing schedule and current authorization requirements."],
  WORKFLOW_EXHAUSTED: ["Automatic processing has stopped", "Review the original task before taking further action through your application."],
  FILE_NOT_READY: ["Message attachment is not ready", "Check attachment processing and wait for completion before sending through your application."],
  FILE_UNAVAILABLE: ["Message attachment is unavailable", "Check attachment retention, safety checks, and permissions."],
  VALIDATION_FAILED: ["Sending request failed validation", "Check the request fields. This category alone does not identify which field is invalid."],
  UNCLASSIFIED_FAILURE: ["Failure cause is not classified", "The available record does not establish a specific cause. Review the original message and route status."],
  SEND_DEADLINE_EXCEEDED: ["Sending deadline exceeded", "No new provider submission will be made. A message already accepted by the provider may still be processed."],
  SUBMISSION_OUTCOME_UNKNOWN: ["Submission outcome is not confirmed", "Check the original submission first. Sending again may produce a duplicate."],
  RECONCILIATION_EXHAUSTED: ["Submission outcome requires manual review", "Automatic checks have stopped. Review the original attempt's recorded facts."],
  SENDER_NOT_AUTHORIZED: ["Sender is not authorized", "Check the current Service and domain permissions."],
  CONTENT_EXPIRED: ["Saved message content has expired", "Message identifiers and delivery history are retained."],
};

export function diagnosticPresentation(value: MailDiagnostic) {
  const [title, advice] = (value.reasonCode && reasons[value.reasonCode]) || classes[value.code];
  const detail = value.detailAvailability === "SPECIFIC"
    ? "A specific cause was confirmed from structured evidence."
    : value.detailAvailability === "NOT_RECORDED"
      ? "The historical record did not retain a more specific cause."
      : value.detailAvailability === "PROVIDER_NOT_SUPPLIED"
        ? "The provider did not supply a confirmed specific cause."
        : "Only the cause category is known; a more specific cause cannot be determined.";
  return { title, advice, detail };
}

export function retryPresentation(value: RetryDisposition) {
  return value.owner === "PROVIDER"
    ? "The provider is processing delivery; wait for the final result."
    : value.action === "SCHEDULED"
      ? "Envoy has scheduled further processing."
      : value.action === "MANUAL_REVIEW"
        ? "Manual review required. This does not authorize resending."
        : "No further processing is scheduled.";
}

type DeliveryPresentation = { title: string; followUp: string | null };
const deliveryStates: Record<DeliveryStatus, DeliveryPresentation> = {
  delivered: { title: "Delivered successfully", followUp: "No action needed" },
  queued: { title: "Queued for delivery", followUp: "Envoy will process this message." },
  submitting: { title: "Submitting to the provider", followUp: "Wait for the submission result before sending again." },
  accepted: { title: "Provider accepted the message", followUp: "Wait for the final delivery result." },
  deferred: { title: "Delivery is deferred", followUp: "Delivery processing is delayed. Check the current schedule." },
  unknown: { title: "Delivery outcome is not confirmed", followUp: "Check the original submission before sending again." },
  bounced: { title: "Delivery bounced", followUp: "Detailed bounce information was not recorded. Review the original message." },
  failed: { title: "Delivery failed", followUp: "Detailed failure information was not recorded. Review the original message." },
  canceled: { title: "Delivery canceled", followUp: "No further delivery processing is scheduled." },
  suppressed: { title: "Recipient is suppressed", followUp: "Review the suppression source before taking further action." },
};

export function deliveryPresentation(value: Pick<EmailRecord, "status" | "diagnostic" | "transport">): DeliveryPresentation {
  if (value.diagnostic) {
    const { title, advice } = diagnosticPresentation(value.diagnostic);
    const retry = value.transport?.retryDisposition;
    return { title, followUp: retry && retry.action !== "STOPPED" ? retryPresentation(retry) : advice };
  }
  const presentation = deliveryStates[value.status];
  if (value.transport && ["queued", "submitting", "accepted", "deferred", "unknown"].includes(value.status)) {
    return { ...presentation, followUp: retryPresentation(value.transport.retryDisposition) };
  }
  return presentation;
}
