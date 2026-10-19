import type { PoolClient } from "pg";
import { inboundDomainAccess, outboundDomainAccess } from "@/modules/identity/infrastructure/authorization";
import type { TasksRepository } from "../application/ports";
import type { Task } from "../contracts";
const due = `s.status NOT IN ('malicious','blocked','purged') AND (s.next_attempt_at<=now() OR s.policy_version IS DISTINCT FROM $1) AND (s.queued_until IS NULL OR s.queued_until<=now()) AND (s.lease_expires_at IS NULL OR s.lease_expires_at<=now()) AND ((s.status NOT IN ('clean','verified') AND s.attempt_count<5) OR s.policy_version IS DISTINCT FROM $1)`;

export function createTasksRepository(client: Pick<PoolClient,"query">): TasksRepository {
return {
  lockInboundParent(input: { id: string; share: boolean }) { return client.query<Record<string,unknown>>(`SELECT i.id FROM inbound_messages i JOIN inbound_attachments a ON a.inbound_message_id=i.id WHERE a.id=$1 ${input.share ? "FOR SHARE" : "FOR UPDATE"} OF i`, [input.id]); },
  lockResource(input: { id: string; kind: "outbound" | "inbound"; share: boolean }) { return client.query<{object_key:string;sha256:string;size_bytes:string;content_purged_at:Date|null}>(`SELECT object_key,sha256,size_bytes,content_purged_at FROM ${input.kind === "outbound" ? "outbound_files" : "inbound_attachments"} WHERE id=$1 ${input.share ? "FOR SHARE" : "FOR UPDATE"}`, [input.id]); },
  expireExhaustedLeases() { return client.query<Record<string,unknown>>(`UPDATE attachment_safety SET status='unavailable',reason='SCAN_RETRIES_EXHAUSTED',lease_token=NULL,lease_expires_at=NULL,queued_until=NULL
      WHERE status='scanning' AND lease_expires_at<=now() AND attempt_count>=5`, []); },
  expireFailedTasks() { return client.query<Record<string,unknown>>(`UPDATE attachment_safety s SET status='unavailable',reason='SCAN_TASK_FAILED',attempt_count=5,queued_until=NULL
      WHERE s.outbox_id IS NOT NULL AND s.status IN ('pending','unavailable') AND EXISTS(SELECT 1 FROM outbox_events o WHERE o.id=s.outbox_id AND o.status='failed')`, []); },
  findDueScopes(input: { version: string; limit: number }) { return client.query<{scope:string}>(`SELECT scope FROM attachment_scan_scopes f
      WHERE EXISTS(SELECT 1 FROM attachment_safety s WHERE s.scope=f.scope AND ${due})
        AND NOT EXISTS(SELECT 1 FROM attachment_safety live WHERE live.scope=f.scope AND (live.queued_until>now() OR live.lease_expires_at>now()))
      ORDER BY last_dispatched_at,scope LIMIT $2 FOR UPDATE SKIP LOCKED`, [input.version, input.limit]); },
  hasLiveScan(input: { scope: string }) { return client.query<Record<string,unknown>>("SELECT 1 FROM attachment_safety WHERE scope=$1 AND (queued_until>now() OR lease_expires_at>now()) LIMIT 1", [input.scope]); },
  findDueTask(input: { version: string; scope: string }) { return client.query<Task>(`SELECT s.* FROM attachment_safety s WHERE s.scope=$2 AND ${due} ORDER BY next_attempt_at,resource_id LIMIT 1 FOR UPDATE`, [input.version, input.scope]); },
  enqueueScanLease(input: { resource_id: string; outboxId: string; version: string }) { return client.query<Record<string,unknown>>(`UPDATE attachment_safety SET queued_until=now()+interval '2 minutes',outbox_id=$2,
        attempt_count=CASE WHEN policy_version IS DISTINCT FROM $3 THEN 0 ELSE attempt_count END,policy_version=$3,status='pending',updated_at=now() WHERE resource_id=$1`, [input.resource_id, input.outboxId, input.version]); },
  insertScanOutbox(input: { outboxId: string; resource_id: string; payload: { resourceId: string; } }) { return client.query<Record<string,unknown>>("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'attachment',$2,'attachment.scan.requested',$3)", [input.outboxId, input.resource_id, input.payload]); },
  touchScope(input: { scope: string }) { return client.query<Record<string,unknown>>("UPDATE attachment_scan_scopes SET last_dispatched_at=clock_timestamp() WHERE scope=$1", [input.scope]); },
  claimScan(input: { resourceId: string; token: string; version: string }) { return client.query<Task>(`UPDATE attachment_safety SET status='scanning',attempt_count=CASE WHEN policy_version IS DISTINCT FROM $3 THEN 1 ELSE attempt_count+1 END,
    lease_token=$2,lease_expires_at=now()+interval '2 minutes',updated_at=now(),policy_version=$3
    WHERE resource_id=$1 AND status NOT IN ('malicious','blocked','purged') AND (next_attempt_at<=now() OR policy_version IS DISTINCT FROM $3)
      AND (attempt_count<5 OR policy_version IS DISTINCT FROM $3) AND (lease_expires_at IS NULL OR lease_expires_at<=now())
      AND NOT(status IN ('clean','verified') AND policy_version=$3) RETURNING *`, [input.resourceId, input.token, input.version]); },
  lockScanLease(input: { resourceId: string; token: string }) { return client.query<Task>("SELECT * FROM attachment_safety WHERE resource_id=$1 AND lease_token=$2 FOR UPDATE", [input.resourceId, input.token]); },
  finishScan(input: { resourceId: string; token: string; status: string; reason: string | null; sha256: string | null }) { return client.query<Record<string,unknown>>(`UPDATE attachment_safety SET status=$3,reason=$4,scanned_sha256=$5,
      checked_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,queued_until=NULL,
      next_attempt_at=now()+LEAST(30*power(2,attempt_count-1),600)*interval '1 second',updated_at=now() WHERE resource_id=$1 AND lease_token=$2`, [input.resourceId, input.token, input.status, input.reason, input.sha256]); },
  findOwnedResource(input: { id: string; serviceId: string; kind: "outbound" | "inbound" }) { return client.query<Record<string,unknown>>(input.kind === "outbound" ? `SELECT id FROM outbound_files f WHERE id=$1 AND service_id=$2 AND ${outboundDomainAccess('f')}` : `SELECT a.id FROM inbound_attachments a JOIN inbound_messages i ON i.id=a.inbound_message_id WHERE a.id=$1 AND i.service_id=$2 AND ${inboundDomainAccess('i')}`, [input.id, input.serviceId]); },
  lockRetrySafety(input: { id: string; kind: "outbound" | "inbound" }) { return client.query<{status:string;lease_expires_at:Date|null;queued_until:Date|null}>("SELECT * FROM attachment_safety WHERE resource_id=$1 AND kind=$2 FOR UPDATE", [input.id, input.kind]); },
  resetScan(input: { id: string }) { return client.query<Record<string,unknown>>("UPDATE attachment_safety SET status='pending',reason=NULL,attempt_count=0,next_attempt_at=now(),outbox_id=NULL,queued_until=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE resource_id=$1", [input.id]); },
  auditRetry(input: { actor: string; id: string }) { return client.query<Record<string,unknown>>("INSERT INTO audit_logs(actor,action,resource_type,resource_id) VALUES($1,'attachment.reprocess','attachment',$2)", [input.actor, input.id]); },
};
}
