import type { UnitOfWork } from '@/platform/transactions';
export type ContentKind = 'inbound' | 'message' | 'file';
export type ContentUnitOfWork = UnitOfWork<ContentRepository>;
export interface ContentRepository {
    enqueueObjectDeletion(input: {
        key: string;
    }): Promise<{
        rows: EnqueueObjectDeletionRow[];
        rowCount: number | null;
    }>;
    lockRawReceipt(input: {
        id: string;
    }): Promise<{
        rows: LockRawReceiptRow[];
        rowCount: number | null;
    }>;
    findPurgeableRawReceipt(input: {
        id: string;
    }): Promise<{
        rows: FindPurgeableRawReceiptRow[];
        rowCount: number | null;
    }>;
    purgeRawReceipt(input: {
        id: string;
    }): Promise<{
        rows: PurgeRawReceiptRow[];
        rowCount: number | null;
    }>;
    lockOwnedContent(input: {
        id: string;
        serviceId: string;
        kind: ContentKind;
    }): Promise<{
        rows: LockOwnedContentRow[];
        rowCount: number | null;
    }>;
    findRetainedFileReferences(input: {
        referenceSnapshot: string;
    }): Promise<{
        rows: FindRetainedFileReferencesRow[];
        rowCount: number | null;
    }>;
    purgeOutboundFile(input: {
        id: string;
    }): Promise<{
        rows: PurgeOutboundFileRow[];
        rowCount: number | null;
    }>;
    lockMessageSubmissions(input: {
        id: string;
    }): Promise<{
        rows: LockMessageSubmissionsRow[];
        rowCount: number | null;
    }>;
    lockMessageDeliveries(input: {
        id: string;
    }): Promise<{
        rows: LockMessageDeliveriesRow[];
        rowCount: number | null;
    }>;
    findUnsettledMessageWork(input: {
        id: string;
    }): Promise<{
        rows: FindUnsettledMessageWorkRow[];
        rowCount: number | null;
    }>;
    lockContentCallbacks(input: {
        id: string;
        kind: ContentKind;
    }): Promise<{
        rows: LockContentCallbacksRow[];
        rowCount: number | null;
    }>;
    purgeCallbackPayloads(input: {
        ids: string[];
    }): Promise<{
        rows: PurgeCallbackPayloadsRow[];
        rowCount: number | null;
    }>;
    lockInboundAttachments(input: {
        id: string;
    }): Promise<{
        rows: LockInboundAttachmentsRow[];
        rowCount: number | null;
    }>;
    purgeInboundAttachmentMetadata(input: {
        id: string;
    }): Promise<{
        rows: PurgeInboundAttachmentMetadataRow[];
        rowCount: number | null;
    }>;
    purgeInboundMessage(input: {
        id: string;
    }): Promise<{
        rows: PurgeInboundMessageRow[];
        rowCount: number | null;
    }>;
    purgeMessageBody(input: {
        id: string;
    }): Promise<{
        rows: PurgeMessageBodyRow[];
        rowCount: number | null;
    }>;
    findMessageRawReceipts(input: {
        id: string;
    }): Promise<{
        rows: FindMessageRawReceiptsRow[];
        rowCount: number | null;
    }>;
    lockOutboundFiles(input: {
        ids: string[];
    }): Promise<{
        rows: LockOutboundFilesRow[];
        rowCount: number | null;
    }>;
    findUnsharedOutboundFile(input: {
        id: string;
        serviceId: string;
        referenceSnapshot: string;
    }): Promise<{
        rows: FindUnsharedOutboundFileRow[];
        rowCount: number | null;
    }>;
    purgeUnsharedOutboundFile(input: {
        id: string;
    }): Promise<{
        rows: PurgeUnsharedOutboundFileRow[];
        rowCount: number | null;
    }>;
    recordContentPurge(input: {
        actor: string;
        resourceType: string;
        id: string;
        details: {
            source: string;
        };
    }): Promise<{
        rows: RecordContentPurgeRow[];
        rowCount: number | null;
    }>;
    readContentTombstone(input: {
        id: string;
        kind: ContentKind;
    }): Promise<{
        rows: ReadContentTombstoneRow[];
        rowCount: number | null;
    }>;
}
export type EnqueueObjectDeletionRow = never;
export type LockRawReceiptRow = never;
export type FindPurgeableRawReceiptRow = {
    raw_object_key: string | null;
    receipt_object_key: string | null;
};
export type PurgeRawReceiptRow = never;
export type LockOwnedContentRow = {
    content_purged_at: Date | null;
    status?: string;
    attachment_snapshot?: {
        fileId: string;
    }[];
    raw_provider_event_id?: string;
    raw_mime_object_key?: string;
    object_key?: string;
};
export type FindRetainedFileReferencesRow = never;
export type PurgeOutboundFileRow = never;
export type LockMessageSubmissionsRow = never;
export type LockMessageDeliveriesRow = never;
export type FindUnsettledMessageWorkRow = never;
export type LockContentCallbacksRow = {
    id: string;
    status: string;
};
export type PurgeCallbackPayloadsRow = never;
export type LockInboundAttachmentsRow = {
    object_key: string;
};
export type PurgeInboundAttachmentMetadataRow = never;
export type PurgeInboundMessageRow = never;
export type PurgeMessageBodyRow = never;
export type FindMessageRawReceiptsRow = {
    id: string;
};
export type LockOutboundFilesRow = never;
export type FindUnsharedOutboundFileRow = {
    object_key: string;
};
export type PurgeUnsharedOutboundFileRow = never;
export type RecordContentPurgeRow = never;
export type ReadContentTombstoneRow = {
    content_purged_at: Date;
};
