export type Diagnostic = {
    code: string;
    message: string;
    stage: string;
    acceptance: "not_accepted" | "accepted" | "unknown";
    retryable: boolean;
    retryDecision: {
        action: "scheduled" | "none" | "manual_review";
        nextAttemptAt?: string;
        reason?: string;
    };
    providerCode?: string;
    smtpStatus?: string;
    occurredAt: string;
};
export function diagnostic(code: string, message: string, stage: string, options: Partial<Omit<Diagnostic, "code" | "message" | "stage">> = {}): Diagnostic {
    return {
        code, message, stage, acceptance: "not_accepted", retryable: false,
        retryDecision: { action: "none" }, occurredAt: new Date().toISOString(), ...options,
    };
}
