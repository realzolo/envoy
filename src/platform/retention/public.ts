import { cleanupOrphanObjects } from "@/platform/storage/object-cleanup/public";
import { objectStore, type ObjectStore } from "@/platform/storage/object-store";
import { createRetentionService } from "./application/service";
import { retentionSession } from "./infrastructure/retention.repository";
import type { RetentionOptions } from "./options";
export { retentionOptions } from "./options";
export type { RetentionCategory, RetentionOptions, RetentionResult } from "./options";
export function runRetention(options: RetentionOptions, store?: ObjectStore) {
    return createRetentionService({ session: retentionSession,
        deleteObject: key => (store ?? objectStore()).delete(key),
        cleanupObjects: (apply, limit) => cleanupOrphanObjects(apply, limit, store),
        log: (category, id, error) => console.error("Retention object/record cleanup failed; safe to retry", category, id, error instanceof Error ? error.message : "unknown error"),
    })(options);
}
