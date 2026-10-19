import { MAX_FILE_BYTES } from "@/lib/contracts";
import { createId } from "@/platform/ids";
import { digest } from "../domain/digest";
import { AttachmentUseError } from "../domain/safety";
import type { AttachmentDependencies, AttachmentRepositories } from "./ports";
import type { Task } from "../contracts";

export function createTasksService(dependencies: AttachmentDependencies) {
async function lockAttachment(client: AttachmentRepositories, id: string, kind: Task["kind"], share = false) {
  if (kind === "inbound") await client.tasks.lockInboundParent({ id: id, share: share });
  return (await client.tasks.lockResource({ id: id, kind: kind, share: share })).rows[0];
}

async function scheduleAttachmentScans(limit = dependencies.scanPolicy().concurrency) {
  const policy = dependencies.scanPolicy();
  return dependencies.unitOfWork.run(async client => {
    await client.tasks.expireExhaustedLeases();
    await client.tasks.expireFailedTasks();
    const scopes = (await client.tasks.findDueScopes({ version: policy.version, limit: Math.max(1,Math.min(limit,16)) })).rows;
    let count = 0;
    for (const {scope} of scopes) {
      // Recheck in a fresh snapshot after acquiring the scope lock: another scheduler may have just committed.
      if ((await client.tasks.hasLiveScan({ scope: scope })).rowCount) continue;
      const task = (await client.tasks.findDueTask({ version: policy.version, scope: scope })).rows[0];
      if (!task) continue;
      const outboxId = createId("out");
      await client.tasks.enqueueScanLease({ resource_id: task.resource_id, outboxId: outboxId, version: policy.version });
      await client.tasks.insertScanOutbox({ outboxId: outboxId, resource_id: task.resource_id, payload: {resourceId:task.resource_id} });
      await client.tasks.touchScope({ scope: scope });
      count++;
    }
    return count;
  });
}

async function processAttachmentScan(resourceId: string) {
  const policy = dependencies.scanPolicy(), token = createId("scan");
  const task = await dependencies.unitOfWork.run(async client => (await client.tasks.claimScan({ resourceId: resourceId, token: token, version: policy.version })).rows[0]);
  if (!task) return;
  let sourceKey:string|undefined;
  let status = "unavailable", reason: string | null = "FILE_STORAGE_UNAVAILABLE", sha256: string | null = null;
  try {
    const source = await dependencies.unitOfWork.run(client => client.lockAttachment(resourceId,task.kind,true));
    if (!source || source.content_purged_at) { status="purged";reason="FILE_CONTENT_PURGED"; }
    else {
      sourceKey=source.object_key;
      const bytes = await dependencies.objectStore.get(source.object_key,MAX_FILE_BYTES);
      sha256 = digest(bytes);
      if (bytes.byteLength !== Number(source.size_bytes) || source.sha256 !== sha256 || task.expected_sha256 !== sha256) {
        status="blocked";reason="FILE_INTEGRITY_FAILED";
      } else { const result = await dependencies.scanBytes(bytes);status=result.status;reason=result.reason; }
    }
  } catch { /* Store/network details and object keys must not enter job logs or public diagnostics. */ }
  await dependencies.unitOfWork.run(async client => {
    const source = await client.lockAttachment(resourceId,task.kind);
    const row = (await client.tasks.lockScanLease({ resourceId: resourceId, token: token })).rows[0];
    if (!row) return; // A later claim or erasure fences this result.
    if (!source || source.content_purged_at) {status="purged";reason="FILE_CONTENT_PURGED";}
    if (source && sourceKey && source.object_key!==sourceKey) {status="blocked";reason="FILE_INTEGRITY_FAILED";}
    if (source && sha256 && source.sha256!==sha256) {status="blocked";reason="FILE_INTEGRITY_FAILED";}
    if (policy.version !== dependencies.scanPolicy().version && (status === "clean" || status === "verified")) {status="unavailable";reason="FILE_POLICY_CHANGED";}
    await client.tasks.finishScan({ resourceId: resourceId, token: token, status: status, reason: reason, sha256: sha256 });
  });
}

async function retryAttachmentScan(id:string,kind:Task["kind"],serviceId:string|null,actor:string) {
  return dependencies.unitOfWork.run(async client => {
    if (serviceId !== null) {
      const owned = await client.tasks.findOwnedResource({ id: id, serviceId: serviceId, kind: kind });
      if (!owned.rowCount) return null;
    }
    const file = await client.lockAttachment(id,kind);
    if (!file) return null;
    const row = (await client.tasks.lockRetrySafety({ id: id, kind: kind })).rows[0];
    if (!row || file.content_purged_at || ['malicious','blocked','purged'].includes(row.status)) throw new AttachmentUseError("FILE_UNAVAILABLE","FILE_REPROCESSING_FORBIDDEN");
    if ((row.lease_expires_at && row.lease_expires_at.getTime()>Date.now()) || (row.queued_until && row.queued_until.getTime()>Date.now())) return {id,processing:true};
    await client.tasks.resetScan({ id: id });
    await client.tasks.auditRetry({ actor: actor, id: id });
    return {id,processing:true};
  });
}
return { lockAttachment, scheduleAttachmentScans, processAttachmentScan, retryAttachmentScan };
}
