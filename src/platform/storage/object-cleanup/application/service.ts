import type { UnitOfWork } from "@/platform/transactions";
export type CleanupSummary = {
    enabled: boolean;
    eligible: number;
    applied: number;
    failed: number;
};
export interface ObjectCleanupRepository {
    register(key: string): Promise<void>;
    complete(keys: string[]): Promise<number>;
    listCandidates(limit: number): Promise<string[]>;
    claim(key: string): Promise<boolean>;
    isReferenced(key: string): Promise<boolean>;
    removeClaim(key: string): Promise<void>;
    recordFailure(key: string, message: string): Promise<void>;
}
export function createObjectCleanupService(dependencies: {
    repository: ObjectCleanupRepository;
    unitOfWork: UnitOfWork<ObjectCleanupRepository>;
    deleteObject(key: string): Promise<void>;
    log(key: string, message: string): void;
}) {
    async function registerObjectUpload(key: string) { await dependencies.repository.register(key); }
    async function completeObjectUploads(repository: ObjectCleanupRepository, keys: string[]) {
        const unique = [...new Set(keys)].sort();
        if (!unique.length)
            return;
        if (await repository.complete(unique) !== unique.length)
            throw new Error("Object upload claim expired before its references could be committed; retry processing");
    }
    async function cleanupOrphanObjects(apply: boolean, limit: number): Promise<CleanupSummary> {
        const candidates = await dependencies.repository.listCandidates(limit);
        const result = { enabled: true, eligible: candidates.length, applied: 0, failed: 0 };
        if (!apply)
            return result;
        for (const key of candidates) {
            try {
                const applied = await dependencies.unitOfWork.run(async (repository) => {
                    if (!await repository.claim(key))
                        return false;
                    if (!await repository.isReferenced(key))
                        await dependencies.deleteObject(key);
                    await repository.removeClaim(key);
                    return true;
                });
                if (applied)
                    result.applied++;
            }
            catch (error) {
                result.failed++;
                const message = error instanceof Error ? error.message : "Object deletion failed";
                await dependencies.repository.recordFailure(key, message.slice(0, 2000));
                dependencies.log(key, message);
            }
        }
        return result;
    }
    return { registerObjectUpload, completeObjectUploads, cleanupOrphanObjects };
}
