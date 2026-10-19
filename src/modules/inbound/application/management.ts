import type { UnitOfWork } from "@/platform/transactions";
export interface InboundManagementRepository {
  resetRaw(id: string): Promise<boolean>;
  recoverUnroutedReceipt(id: string): Promise<boolean>;
  enqueueRaw(id: string, outboxId: string): Promise<void>;
  lockCopies(rawEventId: string): Promise<void>;
  exhaustedRaw(id: string): Promise<{ providerAccountId: string } | null>;
  activeCopy(rawEventId: string): Promise<boolean>;
  terminateReceipt(rawEventId: string, providerAccountId: string): Promise<void>;
  rejectPendingCopies(rawEventId: string): Promise<void>;
  terminateRaw(id: string): Promise<void>;
  audit(actor: string, action: string, type: string, id: string, details?: Record<string, unknown>): Promise<void>;
}
export function createInboundManagement(unitOfWork: UnitOfWork<InboundManagementRepository>, deps: { id(prefix: string): string }) {
  return {
    replayRawEvent: (id: string, actor: string) => unitOfWork.run(async repo => {
      if (!await repo.resetRaw(id)) throw new Error("Raw event not found or its content has expired.");
      const rerouted = await repo.recoverUnroutedReceipt(id);
      await repo.enqueueRaw(id, deps.id("out"));
      await repo.audit(actor, "provider_event.replay", "raw_provider_event", id, { rerouted });
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
  };
}
