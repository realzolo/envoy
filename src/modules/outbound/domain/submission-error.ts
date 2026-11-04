/** Rejected before invoking the provider: a determinate local failure. */
export class SendPreparationError extends Error {
    constructor(readonly code: import("@/contracts/mail-diagnostics").MailDiagnostic["code"], message: string) { super(message); }
}
