import { createMessageSchema, type CreateMessageInput } from "@/lib/contracts";
import { createId } from "@/platform/ids";
import { SERVICE_REQUESTS_PER_MINUTE } from "@/server/service-limits";
import { z } from "zod";
import { choosePolicyTarget, evaluateCandidate } from "../domain/routing";
import { identifierSchema, routingPolicyInputSchema } from "../domain/routing-input";
import type { createMessageService } from "./message";
import type { OutboundDependencies } from "./ports";
export function createManagementService(dependencies: Omit<OutboundDependencies, "events" | "messages"> & {
    messages: Pick<ReturnType<typeof createMessageService>, "acceptMessage" | "retryDelivery">;
}) {
    async function audit(actor: string, action: string, type: string, id: string | null, details: Record<string, unknown> = {}) {
        await dependencies.repositories.management.recordAudit({ actor: actor, action: action, resourceType: type, resourceId: id, details: details });
    }
    async function createRoutingPolicy(input: {
        name: string;
        services?: { mode: "all" | "selected"; serviceIds?: string[] };
        domainId: string;
        category?: string;
        priority?: number;
        targets: Array<{
            accountId: string;
            identityId: string;
            priority?: number;
            weight?: number;
            rateLimit?: number;
        }>;
    }, actor: string, existingId?: string) {
        const validated = routingPolicyInputSchema.parse(input);
        const id = existingId ?? createId("rp");
        await dependencies.unitOfWork.run(async (client) => {
            const services = await client.management.findServices({ serviceIds: validated.services.serviceIds });
            if (services.rows.length !== validated.services.serviceIds.length) throw new Error("Selected services must exist");
            const domain = await client.management.findDomain({ domainId: validated.domainId });
            if (!domain.rows[0])
                throw new Error("Sending domain not found");
            if (domain.rows[0].status !== "active")
                throw new Error("Routing policies require an active sending domain");
            const identities = await client.management.listTargetIdentities({ identityIds: validated.targets.map(target => target.identityId) });
            if (identities.rows.length !== validated.targets.length)
                throw new Error("One or more provider identities were not found");
            const accountByIdentity = new Map(identities.rows.map(identity => [identity.id, identity.provider_account_id]));
            for (const target of validated.targets) {
                if (accountByIdentity.get(target.identityId) !== target.accountId)
                    throw new Error("Each routing target must use an identity owned by its provider account");
                const identity = identities.rows.find(item => item.id === target.identityId);
                if (identity?.sending_domain_id !== validated.domainId || identity.status !== "verified" || identity.account_status !== "active")
                    throw new Error("Routing targets must be verified identities for the selected sending domain on active provider accounts");
            }
            if (existingId) {
                const current = await client.management.lockPolicy({ policyId: id });
                if (!current.rowCount)
                    throw new Error("Routing policy not found");
                await client.management.deleteUnselectedTargets({ policyId: id, identityIds: validated.targets.map(target => target.identityId) });
                await client.management.updatePolicy({ id: id, name: validated.name, serviceScope: validated.services.mode, domainId: validated.domainId, category: validated.category ?? null, priority: validated.priority });
            }
            else {
                await client.management.insertPolicy({ id: id, name: validated.name, serviceScope: validated.services.mode, domainId: validated.domainId, category: validated.category ?? null, priority: validated.priority });
            }
            await client.management.replacePolicyServices({ policyId: id, serviceIds: validated.services.serviceIds });
            for (const target of validated.targets)
                await client.management.saveTarget({ id: createId("rt"), policyId: id, accountId: target.accountId, identityId: target.identityId, priority: target.priority, weight: target.weight, rateLimit: target.rateLimit });
            await client.management.recordPolicyAudit({ actor: actor, policyId: id, details: {
                    services: validated.services,
                    domainId: validated.domainId,
                    category: validated.category ?? null,
                    priority: validated.priority,
                    targetCount: validated.targets.length
                }, action: existingId ? "routing_policy.update" : "routing_policy.create" });
        });
        return id;
    }
    async function toggleRoutingPolicy(id: string, enabled: boolean, actor: string) {
        await dependencies.repositories.management.setPolicyStatus({ policyId: id, status: enabled ? "active" : "disabled" });
        await audit(actor, "routing_policy.toggle", "routing_policy", id, { enabled });
    }
    async function simulateRouting(input: {
        domainId: string;
        serviceId?: string;
        category?: string;
    }) {
        const domainId = identifierSchema.parse(input.domainId);
        const result = await dependencies.repositories.management.listSimulationCandidates({ domainId: domainId, serviceId: input.serviceId || null, category: input.category || null });
        const candidates = result.rows.map(row => {
            const reasons = evaluateCandidate(row);
            return {
                ...row,
                eligible: reasons.length === 0,
                reasons,
                monthlyUsage: Number(row.monthly_usage),
                dailyUsage: Number(row.daily_usage)
            };
        });
        const eligible = candidates.filter(row => row.eligible).map(row => ({ ...row, policyPriority: row.policy_priority }));
        return { candidates, chosen: choosePolicyTarget(JSON.stringify(input), 1, eligible) ?? null };
    }
    async function manualRetryDelivery(id: string, acknowledgeDuplicateRisk: boolean, actor: string) {
        return dependencies.messages.retryDelivery(id, { actor, acknowledgeUnknown: acknowledgeDuplicateRisk });
    }
    async function sendTestMessage(input: {
        serviceId: string;
        message: CreateMessageInput;
        idempotencyKey: string;
    }, actor: string) {
        const row = (await dependencies.repositories.management.findTestService({ serviceId: input.serviceId })).rows[0];
        if (!row)
            throw new Error("The selected service is unavailable");
        const message = createMessageSchema.parse(input.message);
        const result = await dependencies.messages.acceptMessage({
            identity: {
                serviceId: row.service_id, serviceName: row.service_name,
                rateLimitPerMinute: SERVICE_REQUESTS_PER_MINUTE,
            },
            idempotencyKey: `admin-test-${z.string().uuid().parse(input.idempotencyKey)}`,
            input: message,
        });
        await audit(actor, "message.test_send", "message", result.message.id, { serviceId: input.serviceId });
        return result.message;
    }
    return { createRoutingPolicy, toggleRoutingPolicy, simulateRouting, manualRetryDelivery, sendTestMessage };
}
