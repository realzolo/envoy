import type { RetentionCategory, RetentionResult } from "../options";
export type RetentionRows<Row> = {
    rows: Row[];
    rowCount: number | null;
};
export interface RetentionRepository {
    lockMessage(id: string): Promise<RetentionRows<Record<string, unknown>>>;
    lockMessageSubmissions(id: string): Promise<RetentionRows<Record<string, unknown>>>;
    lockMessageDeliveries(id: string): Promise<RetentionRows<Record<string, unknown>>>;
    findPurgeableMessage(id: string): Promise<RetentionRows<Record<string, unknown>>>;
    purgeMessage(id: string): Promise<RetentionRows<Record<string, unknown>>>;
    lockOutboundFile(id: string): Promise<RetentionRows<Record<string, unknown>>>;
    findPurgeableFile(id: string): Promise<RetentionRows<{
        object_key: string;
    }>>;
    purgeFile(id: string): Promise<RetentionRows<Record<string, unknown>>>;
    findPurgeableProviderEvent(id: string): Promise<RetentionRows<{
        raw_object_key: string | null;
        receipt_object_key: string | null;
    }>>;
    purgeProviderEvent(id: string): Promise<RetentionRows<Record<string, unknown>>>;
    findPurgeableInbound(id: string): Promise<RetentionRows<{
        raw_mime_object_key: string | null;
    }>>;
    listPurgeableInboundAttachments(id: string): Promise<RetentionRows<{
        object_key: string;
    }>>;
    purgeInboundAttachments(id: string): Promise<RetentionRows<Record<string, unknown>>>;
    purgeInbound(id: string): Promise<RetentionRows<Record<string, unknown>>>;
    findPurgeableCallback(id: string): Promise<RetentionRows<Record<string, unknown>>>;
    purgeCallback(id: string): Promise<RetentionRows<Record<string, unknown>>>;
    deleteRequestLog(id: string): Promise<RetentionRows<Record<string, unknown>>>;
    purgeAuditDetails(id: string): Promise<RetentionRows<Record<string, unknown>>>;
    listExpiredStreams(limit: number): Promise<RetentionRows<{
        service_id: string;
    }>>;
    lockStream(serviceId: string): Promise<RetentionRows<Record<string, unknown>>>;
    pruneStream(serviceId: string, limit: number): Promise<RetentionRows<Record<string, unknown>>>;
    selectCandidates(category: RetentionCategory, days: number, limit: number): Promise<RetentionRows<{
        id: string;
    }>>;
    transaction<T>(work: (repository: RetentionRepository) => Promise<T>): Promise<T>;
}
export interface RetentionDependencies {
    session: {
        run<T>(work: (repository: RetentionRepository) => Promise<T>): Promise<T>;
    };
    deleteObject(key: string): Promise<void>;
    cleanupObjects(apply: boolean, limit: number): Promise<RetentionResult["objectDeletions"]>;
    log(category: RetentionCategory, id: string, error: unknown): void;
}
