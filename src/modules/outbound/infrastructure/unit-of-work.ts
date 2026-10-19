import { resolveOutboundAttachments } from "@/modules/attachments/public";
import { authorizedSendingDomain } from "@/modules/identity/public";
import { createUnitOfWork, pool, transactionContext } from "@/platform/database";
import { reserveRateLimits } from "@/platform/runtime-store";
import type { Pool, PoolClient } from "pg";
import type { OutboundRepositories } from "../application/ports";
import { createEventsRepository } from "./events.repository";
import { createManagementRepository } from "./management.repository";
import { createMessageRepository } from "./message.repository";
import { createRoutingRepository } from "./routing.repository";
/** One repository graph owns one physical transaction, including events and Outbox writes. */
export function createOutboundRepositories(executor: Pool | PoolClient, transactionClient?: PoolClient): OutboundRepositories {
    function requiredTransaction() {
        if (!transactionClient)
            throw new Error("This operation requires an outbound transaction");
        return transactionClient;
    }
    return {
        management: createManagementRepository(executor),
        message: createMessageRepository(executor),
        events: createEventsRepository(executor),
        routing: createRoutingRepository(executor),
        authorizedDomain(identity, email) {
            return authorizedSendingDomain(identity.serviceId, email.slice(email.lastIndexOf("@") + 1), transactionContext(requiredTransaction()));
        },
        resolveOutboundAttachments(serviceId, attachments, domainId) {
            return resolveOutboundAttachments(serviceId, attachments, transactionContext(requiredTransaction()), domainId);
        },
        reserveRateLimits(entries) {
            return reserveRateLimits(requiredTransaction(), entries);
        },
    };
}
export const outboundUnitOfWork = createUnitOfWork(client => createOutboundRepositories(client, client));
export function outboundReadRepositories() { return createOutboundRepositories(pool()); }
