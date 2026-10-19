import { z } from "zod";
import type { UnitOfWork } from "@/platform/transactions";
import type { ProviderType } from "@/integrations/providers/contracts";

const identifier = z.string().trim().min(1).max(160);
const routeInput = z.object({ webhookEndpointId: identifier, domainId: identifier, productId: identifier, serviceId: identifier }).strict();
type RouteInput = z.input<typeof routeInput>;
export interface InboundManagementRepository {
  resetRaw(id: string): Promise<boolean>;
  enqueueRaw(id: string, outboxId: string): Promise<void>;
  lockCopies(rawEventId: string): Promise<void>;
  exhaustedRaw(id: string): Promise<{ providerAccountId: string } | null>;
  activeCopy(rawEventId: string): Promise<boolean>;
  terminateReceipt(rawEventId: string, providerAccountId: string): Promise<void>;
  rejectPendingCopies(rawEventId: string): Promise<void>;
  terminateRaw(id: string): Promise<void>;
  routeEndpoint(id: string): Promise<{ type: ProviderType; status: string; securityConfigured: boolean } | null>;
  receivingPermission(input: RouteInput): Promise<boolean>;
  insertRoute(id: string, input: RouteInput): Promise<void>;
  toggleRoute(id: string, enabled: boolean): Promise<void>;
  audit(actor: string, action: string, type: string, id: string, details?: Record<string, unknown>): Promise<void>;
}
export function createInboundManagement(unitOfWork: UnitOfWork<InboundManagementRepository>, deps: { id(prefix: string): string; supportsInbound(type: ProviderType): boolean }) {
  return {
    replayRawEvent: (id: string, actor: string) => unitOfWork.run(async repo => {
      if (!await repo.resetRaw(id)) throw new Error("Raw event not found or its content has expired.");
      await repo.enqueueRaw(id, deps.id("out"));
      await repo.audit(actor, "provider_event.replay", "raw_provider_event", id);
    }),
    terminateRawEvent: (id: string, actor: string) => unitOfWork.run(async repo => {
      await repo.lockCopies(id);
      const raw = await repo.exhaustedRaw(id);
      if (!raw) throw new Error("Only an exhausted, inactive raw event can be terminated");
      if (await repo.activeCopy(id)) throw new Error("Inbound copy processing is still active");
      await repo.terminateReceipt(id, raw.providerAccountId);
      await repo.rejectPendingCopies(id);
      await repo.terminateRaw(id);
      await repo.audit(actor, "provider_event.terminate", "raw_provider_event", id);
    }),
    async createInboundRoute(input: RouteInput, actor: string) {
      const validated = routeInput.parse(input), id = deps.id("ir");
      await unitOfWork.run(async repo => {
        const endpoint = await repo.routeEndpoint(validated.webhookEndpointId);
        if (!endpoint || endpoint.status !== "active" || !endpoint.securityConfigured || !deps.supportsInbound(endpoint.type)) throw new Error("A configured inbound provider endpoint is required");
        if (!await repo.receivingPermission(validated)) throw new Error("The service requires receiving permission for this domain");
        await repo.insertRoute(id, validated);
        await repo.audit(actor, "inbound_route.create", "inbound_route", id, validated);
      });
      return id;
    },
    toggleInboundRoute: (id: string, enabled: boolean, actor: string) => unitOfWork.run(async repo => {
      await repo.toggleRoute(id, enabled);
      await repo.audit(actor, "inbound_route.toggle", "inbound_route", id, { enabled });
    }),
  };
}
