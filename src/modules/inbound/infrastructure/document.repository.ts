import { inboundDocumentSchema,inboundDocumentResourceSchema } from "../domain/document-wire";
import type { Pool,PoolClient } from "pg";
import { pool } from "@/platform/database";
import { inboundDomainAccess } from "@/modules/identity/infrastructure/authorization";
import { attachmentUsage,type SafetyRow } from "@/modules/attachments/public";
import type { DocumentWrite } from "../application/document";
import type { InboundDocument,InboundDocumentResource,InboundResourceReason } from "../contracts";
type Client=Pick<Pool|PoolClient,"query">;
type ResourceRow={metadata:InboundDocumentResource;state:InboundDocumentResource["state"];reason_code:InboundResourceReason|null;content_type:string|null;size_bytes:string|null};
/** Called inside the original ready-copy transaction, never via a second dispatch path. */
export async function saveDocument(client:Client,id:string,write:DocumentWrite) {
  await client.query("UPDATE inbound_messages SET sanitized_html=$2,text_body=$3,document_revision=$4,document_projection=$5,document_source=$6 WHERE id=$1 AND content_purged_at IS NULL",[id,write.html,write.text,write.document.revision,write.document,write.source]);
  for(const item of write.resources) await client.query(`INSERT INTO inbound_document_resources(id,inbound_message_id,document_revision,metadata,source,state,reason_code)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[item.metadata.id,id,write.document.revision,item.metadata,item.source,item.metadata.state,item.metadata.reasonCode]);
}
/** Public metadata is dynamic; private URLs, encrypted sources and cache bytes are never selected. */
export async function readDocumentMetadata(id:string,serviceId:string,projection:InboundDocument|null):Promise<InboundDocument|null> {
  const safe=inboundDocumentSchema.safeParse(projection);
  if(!safe.success)return null;
  const rows=(await pool().query<ResourceRow & {attachment_purged_at:Date|null;attachment_sha256:string|null;safety:SafetyRow|null}>(`SELECT r.metadata,r.state,r.reason_code,r.content_type,r.size_bytes::text,r.scan_policy,
    a.content_purged_at AS attachment_purged_at,a.sha256 AS attachment_sha256,row_to_json(s) AS safety
    FROM inbound_document_resources r JOIN inbound_messages i ON i.id=r.inbound_message_id AND i.document_revision=r.document_revision
    LEFT JOIN inbound_attachments a ON a.id=r.metadata->>'attachmentId' AND a.inbound_message_id=i.id LEFT JOIN attachment_safety s ON s.resource_id=a.id
    WHERE i.id=$1 AND i.service_id=$2 AND i.content_purged_at IS NULL AND ${inboundDomainAccess("i")} ORDER BY r.created_at,r.id`,[id,serviceId])).rows;
  const resources=rows.map(row=>{
    const item:InboundDocumentResource={...row.metadata,state:row.state,reasonCode:row.reason_code,contentType:row.content_type,size:row.size_bytes===null?null:Number(row.size_bytes),downloadEligible:["READY","PREPARING","RETRYABLE"].includes(row.state)};
    if(item.kind==="CID") {
      const usage=attachmentUsage(!!item.attachmentId&&!!row.attachment_sha256&&row.attachment_purged_at===null,row.attachment_sha256,row.safety,"inbound");
      item.state=usage.canDownload?"READY":usage.processing?"PREPARING":"UNAVAILABLE";item.reasonCode=usage.canDownload?null:usage.processing?"SCAN_PENDING":"SOURCE_UNAVAILABLE";item.downloadEligible=usage.canDownload;
    }
    return inboundDocumentResourceSchema.parse(item);
  });
  return {...safe.data,resources};
}
