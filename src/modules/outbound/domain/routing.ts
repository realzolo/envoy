export function configuredLimit(quota: Record<string, unknown>, key: "monthlyLimit" | "dailyLimit") {
    const value = quota[key];
    if (value === undefined)
        return undefined;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function evaluateCandidate(row: {
    account_status: string;
    health: Record<string, unknown>;
    identity_status: string;
    domain_status: string;
    quota: Record<string, unknown>;
    monthly_usage: string;
    daily_usage: string;
}) {
    const reasons: string[] = [];
    if (row.account_status !== "active")
        reasons.push("account_unavailable");
    if (["unhealthy", "offline"].includes(String(row.health.status)))
        reasons.push("account_unhealthy");
    if (row.identity_status !== "verified")
        reasons.push("identity_unverified");
    if (row.domain_status !== "active")
        reasons.push("domain_disabled");
    for (const [key, usage, reason] of [["monthlyLimit", row.monthly_usage, "monthly_quota_exhausted"], ["dailyLimit", row.daily_usage, "daily_quota_exhausted"]] as const) {
        const limit = configuredLimit(row.quota, key);
        if (limit === null)
            reasons.push("invalid_quota");
        else if (limit !== undefined && Number(usage) >= limit)
            reasons.push(reason);
    }
    return reasons;
}
