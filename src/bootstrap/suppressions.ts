import { createUnitOfWork } from "@/platform/database";
import { createId } from "@/platform/ids";
import { createSuppressionService } from "@/modules/suppressions/application/service";
import { suppressionRepository } from "@/modules/suppressions/infrastructure/suppression.repository";
export const suppressions = createSuppressionService(suppressionRepository, createUnitOfWork(suppressionRepository), () => createId("sup"));
