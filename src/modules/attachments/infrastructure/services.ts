import type { PoolClient } from "pg";
import { pool, transaction, transactionClient, transactionContext } from "@/platform/database";
import type { TransactionContext } from "@/platform/transactions";
import { authorizedSendingDomain } from "@/modules/identity/public";
import { objectStore } from "@/platform/storage/object-store";
import { completeObjectUploads, registerObjectUpload } from "@/platform/storage/object-cleanup/public";
import type { AttachmentDependencies, AttachmentRepositories } from "../application/ports";
import { createFilesService } from "../application/files";
import { createTasksService } from "../application/tasks";
import { createAccessService } from "../application/access";
import { createRegistrationService } from "../application/registration";
import { createFilesRepository } from "./files.repository";
import { createTasksRepository } from "./tasks.repository";
import { createAccessRepository } from "./access.repository";
import { createRegistrationRepository } from "./registration.repository";

import { attachmentUsage as usage, assertUsable as assert } from "../domain/safety";
import type { SafetyRow } from "../contracts";
import { scanPolicy, scanBytes } from "./scanner";

export const attachmentUsage = (retained: boolean, sha256: string | null, safety?: SafetyRow | null, direction: "outbound" | "inbound" = "outbound") => usage(scanPolicy().version, retained, sha256, safety, direction);
export const assertUsable = (retained: boolean, sha256: string | null, safety?: SafetyRow | null) => assert(scanPolicy().version, retained, sha256, safety);

function repositories(executor: Pick<PoolClient, "query">, client?: PoolClient): AttachmentRepositories {
  const required = () => { if (!client) throw new Error("Attachment operation requires a transaction"); return client; };
  const graph: AttachmentRepositories = {
    files: createFilesRepository(executor), tasks: createTasksRepository(executor), access: createAccessRepository(executor), registration: createRegistrationRepository(executor),
    authorizedSendingDomain: (serviceId, domain) => authorizedSendingDomain(serviceId, domain, transactionContext(required())),
    completeObjectUploads: keys => completeObjectUploads(transactionContext(required()), keys),
    registerAttachment: (...args) => registrationService.registerAttachment(graph, ...args),
    lockAttachment: (...args) => tasksService.lockAttachment(graph, ...args),
  };
  return graph;
}
const dependencies: AttachmentDependencies = {
  get repositories() { return repositories(pool()); },
  unitOfWork: { run: work => transaction(client => work(repositories(client, client))) },
  authorizedSendingDomain: (serviceId, domain) => authorizedSendingDomain(serviceId, domain),
  registerObjectUpload,
  get objectStore() { return objectStore(); },
  scanPolicy, scanBytes, attachmentUsage, assertUsable,
};
const registrationService = createRegistrationService();
const tasksService = createTasksService(dependencies);
const filesService = createFilesService(dependencies);
export const { uploadOutboundFile, getOutboundFile } = filesService;
export const { scheduleAttachmentScans, processAttachmentScan, retryAttachmentScan } = tasksService;
export const { readAttachment, withSafeOutboundAttachments } = createAccessService(dependencies);
export function resolveOutboundAttachments(serviceId: string, attachments: Parameters<typeof filesService.resolveOutboundAttachments>[1], context?: TransactionContext, domainId?: string) {
  const client = context ? transactionClient(context) : undefined;
  return filesService.resolveOutboundAttachments(serviceId, attachments, client ? repositories(client, client) : undefined, domainId);
}
export function registerAttachment(context: TransactionContext, id: string, kind: "outbound" | "inbound", serviceId: string | null, sha256: string) {
  const client = transactionClient(context);
  return registrationService.registerAttachment(repositories(client, client), id, kind, serviceId, sha256);
}
