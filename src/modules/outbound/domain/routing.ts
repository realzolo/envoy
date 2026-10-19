import { createHash } from "node:crypto";
export function chooseWeighted<T extends {
    priority: number;
    weight: number;
}>(deliveryId: string, attempt: number, candidates: T[]) {
    if (!candidates.length)
        return undefined;
    const min = Math.min(...candidates.map(c => c.priority));
    const eligible = candidates.filter(c => c.priority === min);
    const total = eligible.reduce((sum, c) => sum + c.weight, 0);
    const hash = createHash("sha256").update(`${deliveryId}:${attempt}`).digest().readUInt32BE(0) % total;
    let cursor = hash;
    for (const item of eligible) {
        cursor -= item.weight;
        if (cursor < 0)
            return item;
    }
    return eligible[0];
}
export function choosePolicyTarget<T extends {
    policyPriority: number;
    priority: number;
    weight: number;
}>(deliveryId: string, attempt: number, candidates: T[]) {
    if (!candidates.length)
        return undefined;
    const policyPriority = Math.min(...candidates.map(candidate => candidate.policyPriority));
    return chooseWeighted(deliveryId, attempt, candidates.filter(candidate => candidate.policyPriority === policyPriority));
}
export function configuredLimit(quota: Record<string, unknown>, key: "monthlyLimit" | "dailyLimit") {
    const value = quota[key];
    if (value === undefined)
        return undefined;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function positiveInteger(value: string | undefined, fallback: number) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
export function evaluateCandidate(row: {
    status: string;
    circuit_open_until: Date | null;
    account_status: string;
    health: Record<string, unknown>;
    identity_status: string;
    domain_status: string;
    quota: Record<string, unknown>;
    monthly_usage: string;
    daily_usage: string;
}, now = new Date()) {
    const reasons: string[] = [];
    if (row.status === "circuit_open" && (!row.circuit_open_until || row.circuit_open_until > now))
        reasons.push("circuit_open");
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
