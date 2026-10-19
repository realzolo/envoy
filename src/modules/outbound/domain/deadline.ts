export const messagePolicies = {
    sendBefore: true,
    contentPolicies: ["normal", "sensitive"],
    sensitive: { requiresSendBefore: true, maxRetentionSeconds: 900, contentReadable: false },
} as const;
export const SENSITIVE_SUBJECT = "[Sensitive content]";
export const DEADLINE_CODE = "SEND_DEADLINE_EXCEEDED";
export const DEADLINE_MESSAGE = "The message sending deadline has passed; no new provider submission is allowed.";
export class SendDeadlineError extends Error {
    readonly code = DEADLINE_CODE;
    constructor() { super(DEADLINE_MESSAGE); }
}
export function assertSendDeadline(sendBefore?: Date | string | null, now = Date.now()) {
    if (sendBefore && new Date(sendBefore).getTime() <= now)
        throw new SendDeadlineError();
}
