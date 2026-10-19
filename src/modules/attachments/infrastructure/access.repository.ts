import type { PoolClient } from "pg";
import { inboundDomainAccess, outboundDomainAccess } from "@/modules/identity/infrastructure/authorization";
import type { AccessRepository } from "../application/ports";
import type { SafetyRow } from "../contracts";

export function createAccessRepository(client: Pick<PoolClient,"query">): AccessRepository {
return {
  rememberByteFailure(input: { id: string; status: "unavailable" | "blocked"; reasonCode: string }) { return client.query<Record<string,unknown>>(`UPDATE attachment_safety SET status=$2,reason=$3,attempt_count=0,next_attempt_at=now(),
      lease_token=NULL,lease_expires_at=NULL,queued_until=NULL,updated_at=now()
      WHERE resource_id=$1 AND status NOT IN ('malicious','blocked','purged')`, [input.id, input.status, input.reasonCode]); },
  lockAuthorizedOwner(input: { messageId: string }) { return client.query<{service_id:string;sending_domain_id:string;content_purged_at:Date|null;send_before:Date|null}>(`SELECT service_id,sending_domain_id,content_purged_at,send_before FROM messages m WHERE id=$1 AND ${outboundDomainAccess('m')} FOR SHARE`, [input.messageId]); },
  lockOwnedFile(input: { fileId: string; service_id: string; sending_domain_id: string }) { return client.query<{sha256:string;object_key:string;size_bytes:string;content_purged_at:Date|null}>("SELECT sha256,object_key,size_bytes,content_purged_at FROM outbound_files WHERE id=$1 AND service_id=$2 AND sending_domain_id=$3 FOR SHARE", [input.fileId, input.service_id, input.sending_domain_id]); },
  lockSafety(input: { fileId: string }) { return client.query<SafetyRow>("SELECT * FROM attachment_safety WHERE resource_id=$1 FOR SHARE", [input.fileId]); },
  readSafety(input: { fileId: string }) { return client.query<SafetyRow>("SELECT * FROM attachment_safety WHERE resource_id=$1", [input.fileId]); },
  lockLiveAttempt(input: { attemptId: string; messageId: string }) { return client.query<Record<string,unknown>>(`SELECT a.id FROM submission_attempts a JOIN submissions s ON s.id=a.submission_id
        WHERE a.id=$1 AND s.message_id=$2 AND s.current_attempt_id=a.id AND s.status='submitting'
          AND a.status='submitting' AND a.submission_deadline_at>clock_timestamp() FOR SHARE OF a,s`, [input.attemptId, input.messageId]); },
  verifySendingPermission(input: { messageId: string }) { return client.query<Record<string,unknown>>(`SELECT id FROM messages m WHERE id=$1 AND ${outboundDomainAccess('m')}`, [input.messageId]); },
  findDownloadableFile(input: { id: string; serviceId: string | undefined }) { return client.query<{file_name:string;sha256:string;content_purged_at:Date|null}>(`SELECT file_name,sha256,content_purged_at FROM outbound_files f WHERE id=$1 AND service_id=$2 AND ${outboundDomainAccess('f')}`, [input.id, input.serviceId]); },
  findInboundDownload(input: { id: string; parentId: string | undefined; serviceId: string | null }) { return client.query<{file_name:string;sha256:string;content_purged_at:Date|null}>(`SELECT a.file_name,a.sha256,a.content_purged_at FROM inbound_attachments a JOIN inbound_messages i ON i.id=a.inbound_message_id
        WHERE a.id=$1 AND i.id=$2 AND ($3::text IS NULL OR i.service_id=$3) AND ($3::text IS NULL OR ${inboundDomainAccess('i')}) AND i.status='ready' AND i.content_purged_at IS NULL`, [input.id, input.parentId, input.serviceId]); },
  lockDownloadSafety(input: { id: string }) { return client.query<SafetyRow>("SELECT * FROM attachment_safety WHERE resource_id=$1 FOR SHARE", [input.id]); },
  verifyFilePermission(input: { id: string; serviceId: string }) { return client.query<Record<string,unknown>>(`SELECT id FROM outbound_files f WHERE id=$1 AND service_id=$2 AND ${outboundDomainAccess('f')}`, [input.id, input.serviceId]); },
  verifyInboundPermission(input: { parentId: string | undefined; serviceId: string }) { return client.query<Record<string,unknown>>(`SELECT id FROM inbound_messages i WHERE id=$1 AND service_id=$2 AND ${inboundDomainAccess('i')}`, [input.parentId, input.serviceId]); },
};
}
