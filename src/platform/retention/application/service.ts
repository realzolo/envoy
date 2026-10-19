import { retentionPolicies, type RetentionCategory, type RetentionOptions, type RetentionResult } from "../options";
import type { RetentionDependencies, RetentionRepository } from "./ports";
export function createRetentionService(dependencies: RetentionDependencies) {
    async function purge(client: RetentionRepository, category: RetentionCategory, id: string) {
        if (category === "messages") {
            // Serialize with retry/submit and recheck after locks: pending work must keep its original content.
            await client.lockMessage(id);
            await client.lockMessageSubmissions(id);
            await client.lockMessageDeliveries(id);
            const row = await client.findPurgeableMessage(id);
            if (!row.rowCount)
                return false;
            await client.purgeMessage(id);
        }
        else if (category === "outboundFiles") {
            // Acceptance takes FOR SHARE on these rows before committing its message
            // snapshot. Lock first, then recheck references in a fresh statement snapshot.
            await client.lockOutboundFile(id);
            const row = await client.findPurgeableFile(id);
            if (!row.rowCount)
                return false;
            await dependencies.deleteObject(row.rows[0].object_key);
            await client.purgeFile(id);
        }
        else if (category === "rawEvents") {
            const row = await client.findPurgeableProviderEvent(id);
            if (!row.rowCount)
                return false;
            if (row.rows[0].raw_object_key)
                await dependencies.deleteObject(row.rows[0].raw_object_key);
            if (row.rows[0].receipt_object_key)
                await dependencies.deleteObject(row.rows[0].receipt_object_key);
            await client.purgeProviderEvent(id);
        }
        else if (category === "inbound") {
            const row = await client.findPurgeableInbound(id);
            if (!row.rowCount)
                return false;
            const attachments = await client.listPurgeableInboundAttachments(id);
            for (const attachment of attachments.rows)
                await dependencies.deleteObject(attachment.object_key);
            if (row.rows[0].raw_mime_object_key)
                await dependencies.deleteObject(row.rows[0].raw_mime_object_key);
            await client.purgeInboundAttachments(id);
            await client.purgeInbound(id);
        }
        else if (category === "callbacks") {
            const row = await client.findPurgeableCallback(id);
            if (!row.rowCount)
                return false;
            await client.purgeCallback(id);
        }
        else if (category === "requestLogs") {
            await client.deleteRequestLog(id);
        }
        else {
            await client.purgeAuditDetails(id);
        }
        return true;
    }
    return async function runRetention(options: RetentionOptions): Promise<RetentionResult> {
        return dependencies.session.run(async (client) => {
            const result = {} as RetentionResult;
            for (const category of Object.keys(retentionPolicies) as RetentionCategory[]) {
                const days = category === "outboundFiles" ? options.days.outboundFiles ?? options.days.messages : options.days[category];
                const summary = result[category] = { enabled: Boolean(days), eligible: 0, applied: 0, failed: 0 };
                if (!days)
                    continue;
                const candidates = await client.selectCandidates(category, days, options.batchSize);
                summary.eligible = candidates.rowCount ?? 0;
                if (!options.apply)
                    continue;
                for (const { id } of candidates.rows) {
                    try {
                        const applied = await client.transaction(repository => purge(repository, category, id));
                        if (applied)
                            summary.applied++;
                    }
                    catch (error) {
                        summary.failed++;
                        dependencies.log(category, id, error);
                    }
                }
            }
            if (options.apply) {
                for (const { service_id: serviceId } of (await client.listExpiredStreams(options.batchSize)).rows) {
                    await client.transaction(async (repository) => { await repository.lockStream(serviceId); await repository.pruneStream(serviceId, options.batchSize); });
                }
            }
            result.objectDeletions = await dependencies.cleanupObjects(options.apply, options.batchSize);
            return result;
        });
    };
}
