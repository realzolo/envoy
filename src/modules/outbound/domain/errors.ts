export class MessageValidationError extends Error {
    constructor(public readonly issues: string[], public readonly code = "INVALID_MESSAGE") { super(issues.join(" ")); }
}
export class IdempotencyConflictError extends Error {
    constructor() { super("The idempotency key was already used with different content."); }
}
export class DuplicateRiskError extends Error {
}
