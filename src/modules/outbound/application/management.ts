import { createMessageSchema, type CreateMessageInput } from "@/lib/contracts";
import { SERVICE_REQUESTS_PER_MINUTE } from "@/server/service-limits";
import { z } from "zod";
import type { createMessageService } from "./message";
import type { OutboundDependencies } from "./ports";
export function createManagementService(dependencies: Omit<OutboundDependencies, "events" | "messages"> & {
    messages: Pick<ReturnType<typeof createMessageService>, "acceptMessage" | "retryDelivery">;
}) {
    async function audit(actor: string, action: string, type: string, id: string | null, details: Record<string, unknown> = {}) {
        await dependencies.repositories.management.recordAudit({ actor: actor, action: action, resourceType: type, resourceId: id, details: details });
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
    return { manualRetryDelivery, sendTestMessage };
}
