import type { ContentRepository, ContentUnitOfWork } from './content-ports';
import { ContentConflictError } from '../contracts';
export function createContentService(unitOfWork: ContentUnitOfWork) {
    async function forgetObject(client: ContentRepository, key: string | null) {
        if (key)
            await client.enqueueObjectDeletion({ key: key });
    }
    async function purgeUnsharedRaw(client: ContentRepository, id: string) {
        await client.lockRawReceipt({ id: id });
        const raw = (await client.findPurgeableRawReceipt({ id: id })).rows[0];
        if (!raw)
            return;
        await forgetObject(client, raw.raw_object_key);
        await forgetObject(client, raw.receipt_object_key);
        await client.purgeRawReceipt({ id: id });
    }
    /** Tombstones and deletion intents commit atomically; storage failures cannot restore API access. */
    async function purgeContent(kind: "inbound" | "message" | "file", id: string, serviceId: string) {
        return unitOfWork.run(async (client) => {
            const row = (await client.lockOwnedContent({ id: id, serviceId: serviceId, kind: kind })).rows[0];
            if (!row)
                return null;
            if (row.content_purged_at)
                return { id, contentPurgedAt: row.content_purged_at.toISOString(), objectDeletion: "pending_or_complete" };
            if (kind === "file") {
                // Acceptance locks files FOR SHARE. A retained snapshot still needs the original bytes.
                const used = await client.findRetainedFileReferences({ referenceSnapshot: JSON.stringify([{ fileId: id }]) });
                if (used.rowCount)
                    throw new ContentConflictError("CONTENT_SHARED");
                await forgetObject(client, row.object_key!);
                await client.purgeOutboundFile({ id: id });
            }
            else {
                if (kind === "message") {
                    await client.lockMessageSubmissions({ id: id });
                    await client.lockMessageDeliveries({ id: id });
                    const unsafe = await client.findUnsettledMessageWork({ id: id });
                    if (unsafe.rowCount)
                        throw new ContentConflictError("CONTENT_BUSY");
                }
                else if (row.status === "scanning")
                    throw new ContentConflictError("CONTENT_BUSY");
                const callbacks = (await client.lockContentCallbacks({ id: id, kind: kind })).rows;
                if (callbacks.some(c => c.status === "delivering"))
                    throw new ContentConflictError("CONTENT_BUSY");
                await client.purgeCallbackPayloads({ ids: callbacks.map(c => c.id) });
                if (kind === "inbound") {
                    const files = (await client.lockInboundAttachments({ id: id })).rows;
                    for (const file of files)
                        await forgetObject(client, file.object_key);
                    await forgetObject(client, row.raw_mime_object_key ?? null);
                    await client.purgeInboundAttachmentMetadata({ id: id });
                    await client.purgeInboundMessage({ id: id });
                    // Raw ingress is shared administrative evidence. It can be erased only after all frozen copies are gone.
                    if (row.raw_provider_event_id)
                        await purgeUnsharedRaw(client, row.raw_provider_event_id);
                }
                else {
                    await client.purgeMessageBody({ id: id });
                    const rawIds = (await client.findMessageRawReceipts({ id: id })).rows;
                    for (const raw of rawIds)
                        await purgeUnsharedRaw(client, raw.id);
                    // Files have their own service-owned lifecycle: remove only unshared files after message snapshots disappear.
                    await client.lockOutboundFiles({ ids: (row.attachment_snapshot ?? []).map(file => file.fileId) });
                    // Recheck references in a fresh snapshot after waiting for the file locks.
                    for (const file of row.attachment_snapshot ?? []) {
                        const owned = (await client.findUnsharedOutboundFile({ id: file.fileId, serviceId: serviceId, referenceSnapshot: JSON.stringify([{ fileId: file.fileId }]) })).rows[0];
                        if (owned) {
                            await forgetObject(client, owned.object_key);
                            await client.purgeUnsharedOutboundFile({ id: file.fileId });
                        }
                    }
                }
            }
            await client.recordContentPurge({ actor: `service:${serviceId}`, resourceType: kind === 'inbound' ? 'inbound_messages' : kind === 'message' ? 'messages' : 'outbound_files', id: id, details: { source: "service_request" } });
            const result = (await client.readContentTombstone({ id: id, kind: kind })).rows[0];
            return { id, contentPurgedAt: result.content_purged_at.toISOString(), objectDeletion: "pending_or_complete" };
        });
    }
    return purgeContent;
}
