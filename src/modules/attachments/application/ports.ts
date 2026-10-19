import type { UnitOfWork } from "@/platform/transactions";
import type { SafetyRow, FileRow, Task } from "../contracts";
export type RepositoryResult<Row> = { rows: Row[]; rowCount: number | null };

export interface FilesRepository {
  insertFile(input: { id: string; serviceId: string; fileName: string; contentType: string; byteLength: number; sha256: string; key: string; domainId: string }): Promise<RepositoryResult<Record<string,unknown>>>;
  findAuthorizedFile(input: { id: string; serviceId: string }): Promise<RepositoryResult<FileRow>>;
  listLockedFiles(input: { fileIds: string[]; serviceId: string }): Promise<RepositoryResult<FileRow>>;
  listFiles(input: { fileIds: string[]; serviceId: string }): Promise<RepositoryResult<FileRow>>;
  listLockedSafety(input: { resourceIds: string[] }): Promise<RepositoryResult<SafetyRow & {resource_id:string}>>;
}

export interface TasksRepository {
  lockInboundParent(input: { id: string; share: boolean }): Promise<RepositoryResult<Record<string,unknown>>>;
  lockResource(input: { id: string; kind: "outbound" | "inbound"; share: boolean }): Promise<RepositoryResult<{object_key:string;sha256:string;size_bytes:string;content_purged_at:Date|null}>>;
  expireExhaustedLeases(): Promise<RepositoryResult<Record<string,unknown>>>;
  expireFailedTasks(): Promise<RepositoryResult<Record<string,unknown>>>;
  findDueScopes(input: { version: string; limit: number }): Promise<RepositoryResult<{scope:string}>>;
  hasLiveScan(input: { scope: string }): Promise<RepositoryResult<Record<string,unknown>>>;
  findDueTask(input: { version: string; scope: string }): Promise<RepositoryResult<Task>>;
  enqueueScanLease(input: { resource_id: string; outboxId: string; version: string }): Promise<RepositoryResult<Record<string,unknown>>>;
  insertScanOutbox(input: { outboxId: string; resource_id: string; payload: { resourceId: string; } }): Promise<RepositoryResult<Record<string,unknown>>>;
  touchScope(input: { scope: string }): Promise<RepositoryResult<Record<string,unknown>>>;
  claimScan(input: { resourceId: string; token: string; version: string }): Promise<RepositoryResult<Task>>;
  lockScanLease(input: { resourceId: string; token: string }): Promise<RepositoryResult<Task>>;
  finishScan(input: { resourceId: string; token: string; status: string; reason: string | null; sha256: string | null }): Promise<RepositoryResult<Record<string,unknown>>>;
  findOwnedResource(input: { id: string; serviceId: string; kind: "outbound" | "inbound" }): Promise<RepositoryResult<Record<string,unknown>>>;
  lockRetrySafety(input: { id: string; kind: "outbound" | "inbound" }): Promise<RepositoryResult<{status:string;lease_expires_at:Date|null;queued_until:Date|null}>>;
  resetScan(input: { id: string }): Promise<RepositoryResult<Record<string,unknown>>>;
  auditRetry(input: { actor: string; id: string }): Promise<RepositoryResult<Record<string,unknown>>>;
}

export interface AccessRepository {
  rememberByteFailure(input: { id: string; status: "unavailable" | "blocked"; reasonCode: string }): Promise<RepositoryResult<Record<string,unknown>>>;
  lockAuthorizedOwner(input: { messageId: string }): Promise<RepositoryResult<{service_id:string;sending_domain_id:string;content_purged_at:Date|null;send_before:Date|null}>>;
  lockOwnedFile(input: { fileId: string; service_id: string; sending_domain_id: string }): Promise<RepositoryResult<{sha256:string;object_key:string;size_bytes:string;content_purged_at:Date|null}>>;
  lockSafety(input: { fileId: string }): Promise<RepositoryResult<SafetyRow>>;
  readSafety(input: { fileId: string }): Promise<RepositoryResult<SafetyRow>>;
  lockLiveAttempt(input: { attemptId: string; messageId: string }): Promise<RepositoryResult<Record<string,unknown>>>;
  verifySendingPermission(input: { messageId: string; attemptId: string }): Promise<RepositoryResult<Record<string,unknown>>>;
  findDownloadableFile(input: { id: string; serviceId: string | undefined }): Promise<RepositoryResult<{file_name:string;sha256:string;content_purged_at:Date|null}>>;
  findInboundDownload(input: { id: string; parentId: string | undefined; serviceId: string | null }): Promise<RepositoryResult<{file_name:string;sha256:string;content_purged_at:Date|null}>>;
  lockDownloadSafety(input: { id: string }): Promise<RepositoryResult<SafetyRow>>;
  verifyFilePermission(input: { id: string; serviceId: string }): Promise<RepositoryResult<Record<string,unknown>>>;
  verifyInboundPermission(input: { parentId: string | undefined; serviceId: string }): Promise<RepositoryResult<Record<string,unknown>>>;
}

export interface RegistrationRepository {
  ensureScanScope(input: { scope: string }): Promise<RepositoryResult<Record<string,unknown>>>;
  registerSafety(input: { id: string; kind: "outbound" | "inbound"; serviceId: string | null; scope: string; sha256: string }): Promise<RepositoryResult<Record<string,unknown>>>;
}

export type LockedAttachment = { object_key: string; sha256: string; size_bytes: string; content_purged_at: Date | null };
export interface AttachmentRepositories {
  files: FilesRepository;
  tasks: TasksRepository;
  access: AccessRepository;
  registration: RegistrationRepository;
  authorizedSendingDomain(serviceId: string, domain: string): Promise<string | null>;
  completeObjectUploads(keys: string[]): Promise<void>;
  registerAttachment(id: string, kind: "outbound" | "inbound", serviceId: string | null, sha256: string): Promise<void>;
  lockAttachment(id: string, kind: "outbound" | "inbound", share?: boolean): Promise<LockedAttachment | undefined>;
}
export interface AttachmentDependencies {
  repositories: AttachmentRepositories;
  unitOfWork: UnitOfWork<AttachmentRepositories>;
  authorizedSendingDomain(serviceId: string, domain: string): Promise<string | null>;
  registerObjectUpload(key: string): Promise<void>;
  objectStore: {
    put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
    get(key: string, maxBytes: number): Promise<Uint8Array>;
  };
  scanPolicy(): { version: string; timeout: number; concurrency: number; configured: boolean; mode: "require_clean" };
  scanBytes(bytes: Uint8Array): Promise<{ status: "clean" | "malicious" | "unavailable"; reason: string | null; sha256: string }>;
  attachmentUsage(retained: boolean, sha256: string | null, safety?: SafetyRow | null, direction?: "outbound" | "inbound"): import("../domain/safety").AttachmentUsage;
  assertUsable(retained: boolean, sha256: string | null, safety?: SafetyRow | null): void;
}
