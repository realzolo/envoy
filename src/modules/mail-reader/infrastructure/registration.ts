import { createHash } from "node:crypto";
import type { TransactionContext } from "@/platform/transactions";
import { readerCache } from "./cache.repository";
import { compileReader,readerSourceFingerprint } from "../domain/document";
import type { ReaderSource } from "../contracts";
/** Part of the inbound ready transaction: metadata enqueue only, no image/provider HTTP. */
export async function registerReadingSource(source:ReaderSource,context:TransactionContext) {
 const revision=createHash("sha256").update(readerSourceFingerprint(source)).digest("hex");
 for(const resource of compileReader(source).resources)await readerCache.enqueue({kind:source.kind,id:source.id,revision,resourceId:resource.id},source.serviceId,context);
}
