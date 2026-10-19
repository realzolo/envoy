import type { PoolClient } from "pg";
import { outboundDomainAccess } from "@/modules/identity/infrastructure/authorization";
import type { FilesRepository } from "../application/ports";
import type { SafetyRow, FileRow } from "../contracts";

export function createFilesRepository(client: Pick<PoolClient,"query">): FilesRepository {
return {
  insertFile(input: { id: string; serviceId: string; fileName: string; contentType: string; byteLength: number; sha256: string; key: string; domainId: string }) { return client.query<Record<string,unknown>>(`INSERT INTO outbound_files(id,service_id,file_name,content_type,size_bytes,sha256,object_key,sending_domain_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [input.id, input.serviceId, input.fileName, input.contentType, input.byteLength, input.sha256, input.key, input.domainId]); },
  findAuthorizedFile(input: { id: string; serviceId: string }) { return client.query<FileRow>(`SELECT f.*,row_to_json(s) AS safety FROM outbound_files f LEFT JOIN attachment_safety s ON s.resource_id=f.id WHERE f.id=$1 AND f.service_id=$2 AND ${outboundDomainAccess('f')}`, [input.id, input.serviceId]); },
  listLockedFiles(input: { fileIds: string[]; serviceId: string }) { return client.query<FileRow>(`SELECT f.*, (SELECT row_to_json(s) FROM attachment_safety s WHERE s.resource_id=f.id) AS safety FROM outbound_files f WHERE f.id=ANY($1::text[]) AND f.service_id=$2 AND ${outboundDomainAccess('f')} ORDER BY f.id FOR SHARE`, [input.fileIds, input.serviceId]); },
  listFiles(input: { fileIds: string[]; serviceId: string }) { return client.query<FileRow>(`SELECT f.*, (SELECT row_to_json(s) FROM attachment_safety s WHERE s.resource_id=f.id) AS safety FROM outbound_files f WHERE f.id=ANY($1::text[]) AND f.service_id=$2 AND ${outboundDomainAccess('f')} ORDER BY f.id`, [input.fileIds, input.serviceId]); },
  listLockedSafety(input: { resourceIds: string[] }) { return client.query<SafetyRow & {resource_id:string}>("SELECT * FROM attachment_safety WHERE resource_id=ANY($1::text[]) ORDER BY resource_id FOR SHARE", [input.resourceIds]); },
};
}
