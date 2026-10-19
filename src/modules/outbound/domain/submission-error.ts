/** Rejected before invoking the provider: a determinate local failure. */
export class SendPreparationError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}
