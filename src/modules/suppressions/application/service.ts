import type { UnitOfWork } from "@/platform/transactions";
import { adminSuppressionSchema, type AdminSuppressionInput, type SuppressionDto, type SuppressionInput } from "../contracts";

export interface SuppressionRepository {
  list(serviceId: string, email?: string | null): Promise<SuppressionDto[]>;
  lockScope(input: SuppressionInput): Promise<void>;
  existing(input: SuppressionInput): Promise<string | null>;
  insert(id: string, input: AdminSuppressionInput, source: "admin" | "service_api"): Promise<void>;
  serviceExists(id: string): Promise<boolean>;
  deactivate(id: string, serviceId?: string): Promise<{ id: string } | null>;
  audit(actor: string, action: string, id: string, details?: Record<string, unknown>): Promise<void>;
}
export function createSuppressionService(repository: () => SuppressionRepository, unitOfWork: UnitOfWork<SuppressionRepository>, id: () => string) {
  return {
    listSuppressions: (serviceId: string, email?: string | null) => repository().list(serviceId, email),
    createSuppression: (input: SuppressionInput) => unitOfWork.run(async repo => {
      const normalized = { ...input, email: input.email.toLowerCase() };
      await repo.lockScope(normalized);
      const existing = await repo.existing(normalized);
      if (existing) return { id: existing, duplicate: true };
      const suppressionId = id();
      await repo.insert(suppressionId, normalized, "service_api");
      return { id: suppressionId, duplicate: false };
    }),
    removeSuppression: (suppressionId: string, serviceId: string) => repository().deactivate(suppressionId, serviceId),
    async addSuppression(input: AdminSuppressionInput, actor: string) {
      const validated = adminSuppressionSchema.parse(input), suppressionId = id();
      await unitOfWork.run(async repo => {
        if (validated.serviceId && !await repo.serviceExists(validated.serviceId)) throw new Error("Service not found");
        await repo.insert(suppressionId, validated, "admin");
        await repo.audit(actor, "suppression.create", suppressionId, { email: validated.email });
      });
      return suppressionId;
    },
    removeSuppressionForAdmin: (suppressionId: string, actor: string) => unitOfWork.run(async repo => {
      await repo.deactivate(suppressionId);
      await repo.audit(actor, "suppression.remove", suppressionId);
    }),
  };
}
