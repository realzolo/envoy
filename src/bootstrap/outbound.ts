import { createUnitOfWork } from "@/platform/database";
import { createOutboundChanges } from "@/modules/outbound/application/changes";
import { outboundChangesRepository } from "@/modules/outbound/infrastructure/changes.read-repository";
import { safeDiagnostic } from "@/integrations/providers/shared";
import type { ProviderType } from "@/integrations/providers/contracts";
import { providerRegistry } from "@/integrations/providers/registry";
import { createDeliveryWorkflow } from "@/modules/outbound/application/delivery";
import { createEventsService } from "@/modules/outbound/application/events";
import { createManagementService } from "@/modules/outbound/application/management";
import { createMessageService } from "@/modules/outbound/application/message";
import { createReconciliationWorkflow } from "@/modules/outbound/application/reconciliation";
import { createRoutingService } from "@/modules/outbound/application/routing";
import type { DeliveryStateEvent } from "@/modules/outbound/contracts";
import { persistedContent, sendingContent } from "@/modules/outbound/infrastructure/content-protection";
import { providerEventDecoder } from "@/modules/outbound/infrastructure/provider-event-decoder";
import { providerReconciler, providerSender } from "@/modules/outbound/infrastructure/provider-sender";
import { createOutboundRepositories, outboundReadRepositories, outboundUnitOfWork } from "@/modules/outbound/infrastructure/unit-of-work";
import { secretDigest } from "@/platform/crypto/envelope";
import { transactionClient } from "@/platform/database";
import type { TransactionContext } from "@/platform/transactions";
const base = {
    safeDiagnostic,
    payloadDigest: secretDigest,
    providerEvents: providerEventDecoder,
    unitOfWork: outboundUnitOfWork,
    providerCapabilities(type: ProviderType) { return providerRegistry(type).descriptor.capabilities; },
    persistedContent,
    sendingContent,
};
function configured<Extension extends object>(extension: Extension) {
    return { ...base, ...extension, get repositories() { return outboundReadRepositories(); } };
}
const events = createEventsService(configured({}));
const messages = createMessageService(configured({ events }));
const routing = createRoutingService(configured({ events, messages }));
const management = createManagementService(configured({ messages }));
export const outbound = { ...events, ...messages, ...routing, ...management,
    deliverSubmission: createDeliveryWorkflow({ ...routing, ...events, sender: providerSender }),
    reconcileAttempt: createReconciliationWorkflow({ ...routing, reconciler: providerReconciler }),
};
/** Join an existing application transaction without exposing the database client to use cases. */
export function projectDeliveryEvent(context: TransactionContext, deliveryId: string, event: DeliveryStateEvent, sourceKey: string, options?: Parameters<typeof events.applyDeliveryEvent>[4]) {
    const client = transactionClient(context);
    return events.applyDeliveryEvent(createOutboundRepositories(client, client), deliveryId, event, sourceKey, options);
}

export const listOutboundChanges = createOutboundChanges(createUnitOfWork(outboundChangesRepository));
