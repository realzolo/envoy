export const retentionPolicies = {
    messages: "ENVOY_RETENTION_CONTENT_DAYS",
    outboundFiles: "ENVOY_RETENTION_CONTENT_DAYS",
    rawEvents: "ENVOY_RETENTION_RAW_DAYS",
    inbound: "ENVOY_RETENTION_INBOUND_DAYS",
    callbacks: "ENVOY_RETENTION_CALLBACK_DAYS",
    requestLogs: "ENVOY_RETENTION_REQUEST_LOG_DAYS",
    auditDetails: "ENVOY_RETENTION_AUDIT_DETAILS_DAYS",
} as const;
export type RetentionCategory = keyof typeof retentionPolicies;
export type RetentionOptions = {
    apply: boolean;
    batchSize: number;
    days: Partial<Record<RetentionCategory, number>>;
};
export type RetentionResult = Record<RetentionCategory | "objectDeletions", {
    enabled: boolean;
    eligible: number;
    applied: number;
    failed: number;
}>;
export function retentionOptions(env: Partial<NodeJS.ProcessEnv> = process.env, apply = false): RetentionOptions {
    const days: RetentionOptions["days"] = {};
    for (const [category, name] of Object.entries(retentionPolicies)) {
        const value = env[name];
        if (!value || value === "0")
            continue;
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 36500)
            throw new Error(`${name} must be an integer between 1 and 36500 (0 disables cleanup)`);
        days[category as RetentionCategory] = parsed;
    }
    const batchSize = Number(env.ENVOY_RETENTION_BATCH_SIZE ?? 100);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
        throw new Error("ENVOY_RETENTION_BATCH_SIZE must be between 1 and 1000");
    return { apply, batchSize, days };
}
