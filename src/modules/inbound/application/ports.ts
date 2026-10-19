import type { InboundDispatch } from "../contracts";
import type { UnitOfWork } from "@/platform/transactions";

export type RepositoryResult<Row> = { rows: Row[]; rowCount: number | null };
export interface InboundRepository {
  findDispatches(input: { endpointId: string; recipients: string[]; accountId: string }): Promise<RepositoryResult<InboundDispatch>>;
  freezeReceipt(input: { accountId: string; externalId: string; routesJson: string; rawEventId: string }): Promise<RepositoryResult<Record<string, unknown>>>;
  readReceipt(input: { accountId: string; externalId: string }): Promise<RepositoryResult<{ routes: InboundDispatch[]; terminated_at:Date | null; ingress_received_at: Date }>>;
  findTombstone(input: { accountId: string; externalId: string }): Promise<RepositoryResult<{id:string}>>;
  insertRejected(input: { id: string; accountId: string; rawEventId: string; externalId: string; messageId: string | null; from: string; to: string[]; cc: string[]; bcc: string[]; subject: string; html: string | null; text: string | null; reason: "NO_RECEIVING_SERVICE" | "ENVELOPE_RECIPIENT_UNAVAILABLE"; receivedAt: Date | undefined; envelope: string[]; replyTo: string[]; inReplyTo: string | null; references: string[]; authorDate: string | null }): Promise<RepositoryResult<{ id: string }>>;
  allowedDomains(input: { serviceId: string; accountId: string }): Promise<RepositoryResult<{domain:string}>>;
  findCopy(input: { accountId: string; externalId: string; scope: string }): Promise<RepositoryResult<{ id: string; status: string; content_purged_at: Date | null }>>;
  insertCopy(input: { id: string; serviceId: string; accountId: string; rawEventId: string; externalId: string; messageId: string | null; from: string; to: string[]; cc: string[]; bcc: string[]; subject: string; html: string | null; text: string | null; receivedAt: Date | undefined; scope: string; envelope: string[]; replyTo: string[]; inReplyTo: string | null; references: string[] }): Promise<RepositoryResult<Record<string, unknown>>>;
  findConcurrentCopy(input: { accountId: string; externalId: string; scope: string }): Promise<RepositoryResult<{
      id: string;
      status: string
    }>>;
  recordDates(input: { id: string; ingressReceivedAt: Date | undefined; authorDate: string | null }): Promise<RepositoryResult<Record<string, unknown>>>;
  claimCopy(input: { id: string; token: string }): Promise<RepositoryResult<{ received_at: Date }>>;
  copyState(input: { id: string }): Promise<RepositoryResult<{ status: string }>>;
  renewClaim(input: { id: string; token: string }): Promise<RepositoryResult<Record<string, unknown>>>;
  authorizeCompletion(input: { id: string }): Promise<RepositoryResult<Record<string, unknown>>>;
  completeCopy(input: { id: string; rawKey: string | null; token: string }): Promise<RepositoryResult<{ id: string; ready_at: Date }>>;
  insertAttachment(input: { id: string; messageId: string; fileName: string; contentType: string; sizeBytes: number; objectKey: string; contentId: string | null; digest: string }): Promise<RepositoryResult<Record<string, unknown>>>;
  subscribedCallbacks(input: { serviceId: string }): Promise<RepositoryResult<{ id: string }>>;
  insertCallback(input: { id: string; endpointId: string; messageId: string; payload: Record<string, unknown> }): Promise<RepositoryResult<Record<string, unknown>>>;
  enqueueCallback(input: { outboxId: string; id: string; payload: Record<string, unknown> }): Promise<RepositoryResult<Record<string, unknown>>>;
  rejectCopy(input: { id: string; reason: string; token: string }): Promise<RepositoryResult<Record<string, unknown>>>;
  releaseClaim(input: { id: string; token: string }): Promise<RepositoryResult<Record<string, unknown>>>;
  registerAttachment(id: string, kind: "inbound", serviceId: string, digest: string): Promise<void>;
  completeUploads(keys: string[]): Promise<void>;
}
export interface InboundDependencies {
  repository: InboundRepository;
  unitOfWork: UnitOfWork<InboundRepository>;
  id(prefix: string): string;
  digest(bytes: Uint8Array): string;
  sanitizeHtml(html: string): string;
  uploads: { register(key: string): Promise<void>; put(key: string, bytes: Uint8Array, contentType: string): Promise<unknown> };
}
