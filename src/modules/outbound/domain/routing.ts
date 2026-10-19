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
    return reasons;
}
