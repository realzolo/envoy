import { createUnitOfWork, transactionClient } from "@/platform/database";
import type { TransactionContext } from "@/platform/transactions";
import { objectStore, type ObjectStore } from "../object-store";
import { createObjectCleanupService } from "./application/service";
import { objectCleanupRepository } from "./infrastructure/repository";
function cleanupService(store?: ObjectStore) {
    return createObjectCleanupService({ repository: objectCleanupRepository(), unitOfWork: createUnitOfWork(objectCleanupRepository),
        deleteObject: key => (store ?? objectStore()).delete(key),
        log: (key, message) => console.error("Orphan object cleanup failed; retained for retry", key, message) });
}
export function registerObjectUpload(key: string) { return cleanupService().registerObjectUpload(key); }
/** Upload claims and newly persisted object references commit in the caller's transaction. */
export function completeObjectUploads(context: TransactionContext, keys: string[]) {
    return cleanupService().completeObjectUploads(objectCleanupRepository(transactionClient(context)), keys);
}
export function cleanupOrphanObjects(apply: boolean, limit: number, store?: ObjectStore) {
    return cleanupService(store).cleanupOrphanObjects(apply, limit);
}
