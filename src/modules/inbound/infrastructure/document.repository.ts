import { inboundDocumentSchema, inboundDocumentResourceSchema } from "../domain/document-wire";
import type { Pool, PoolClient } from "pg";
import { pool } from "@/platform/database";
import { inboundDomainAccess } from "@/modules/identity/infrastructure/authorization";
import { attachmentUsage, type SafetyRow, scanPolicy } from "@/modules/attachments/public";
import type { DocumentRepository, DocumentWrite, ResourceRecord, SealedValue } from "../application/document";
import type { InboundDocument, InboundDocumentResource, InboundResourceReason } from "../contracts";

type Client=Pick<Pool|PoolClient,"query">;
type ResourceRow={metadata:InboundDocumentResource;source:SealedValue|null;cached_content:SealedValue|null;sha256:string|null;scan_policy:string|null;document_revision:string;lease_token:string|null;state:InboundDocumentResource["state"];reason_code:InboundResourceReason|null;content_type:string|null;size_bytes:string|null};
const authorized=`i.id=$1 AND i.service_id=$3 AND i.content_purged_at IS NULL AND i.status='ready' AND ${inboundDomainAccess("i")}`;
const resourceFrom=(row:ResourceRow):ResourceRecord=>({metadata:inboundDocumentResourceSchema.parse({...row.metadata,state:row.state,reasonCode:row.reason_code,contentType:row.content_type,size:row.size_bytes===null?null:Number(row.size_bytes),downloadEligible:!["ERASED","UNAVAILABLE","BLOCKED"].includes(row.state)}),source:row.source,cached:row.cached_content,sha256:row.sha256,scanPolicy:row.scan_policy,revision:row.document_revision,token:row.lease_token});

/** Called inside the original ready-copy transaction, never via a second dispatch path. */
export async function saveDocument(client:Client,id:string,write:DocumentWrite) {
  await client.query("UPDATE inbound_messages SET sanitized_html=$2,text_body=$3,document_revision=$4,document_projection=$5,document_source=$6 WHERE id=$1 AND content_purged_at IS NULL",[id,write.html,write.text,write.document.revision,write.document,write.source]);
  for(const item of write.resources) await client.query(`INSERT INTO inbound_document_resources(id,inbound_message_id,document_revision,metadata,source,state,reason_code)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[item.metadata.id,id,write.document.revision,item.metadata,item.source,item.metadata.state,item.metadata.reasonCode]);
}
export function documentRepository(client:Client=pool()):DocumentRepository {
  return {
    async read(id,serviceId) {
      const row=(await client.query<{id:string;document_revision:string;document_source:SealedValue|null;raw_mime_object_key:string|null;text_body:string|null;document_projection:InboundDocument|null;content_purged_at:Date|null;receipt_id:string|null;provider_type:string;provider_account_id:string;verification:unknown;external_message_id:string;envelope_recipients:string[]}>(`SELECT i.id,i.document_revision::text,i.document_source,i.raw_mime_object_key,i.text_body,i.document_projection,i.content_purged_at,r.id AS receipt_id,pa.type AS provider_type,i.provider_account_id,r.verification,i.external_message_id,i.envelope_recipients FROM inbound_messages i
        JOIN provider_accounts pa ON pa.id=i.provider_account_id
        LEFT JOIN raw_provider_events r ON r.id=i.raw_provider_event_id AND r.provider_account_id=i.provider_account_id AND r.signature_valid AND r.replay_valid AND r.content_purged_at IS NULL AND r.raw_payload_purged_at IS NULL
        WHERE i.id=$1 AND i.service_id=$2 AND i.status='ready' AND ${inboundDomainAccess("i")}`,[id,serviceId])).rows[0];
      return row?{id:row.id,revision:row.document_revision,source:row.document_source,rawKey:row.raw_mime_object_key,text:row.text_body,document:inboundDocumentSchema.safeParse(row.document_projection).data??null,purged:row.content_purged_at!==null,providerIdentity:row.external_message_id?{providerType:row.provider_type,accountId:row.provider_account_id,externalId:row.external_message_id}:null,receipt:row.receipt_id?{id:row.receipt_id,providerType:row.provider_type,accountId:row.provider_account_id,externalId:row.external_message_id,envelope:row.envelope_recipients,verification:row.verification}:null}:null;
    },
    async attachments(id){return (await client.query<{id:string;content_id:string|null}>("SELECT id,content_id FROM inbound_attachments WHERE inbound_message_id=$1 AND content_purged_at IS NULL ORDER BY id",[id])).rows.map(row=>({id:row.id,contentId:row.content_id}));},
    async publish(id,serviceId,expected,write) {
      const row=await client.query(`SELECT i.id FROM inbound_messages i WHERE i.id=$1 AND i.service_id=$2 AND i.document_revision=$3 AND i.content_purged_at IS NULL AND i.status='ready' AND ${inboundDomainAccess("i")} FOR UPDATE`,[id,serviceId,expected]);
      if(!row.rowCount)return false;
      await saveDocument(client,id,write);return true;
    },
    async resource(id,resourceId,serviceId) {
      const row=(await client.query<ResourceRow>(`SELECT r.*,r.document_revision::text FROM inbound_document_resources r JOIN inbound_messages i ON i.id=r.inbound_message_id AND i.document_revision=r.document_revision WHERE ${authorized} AND r.id=$2`,[id,resourceId,serviceId])).rows[0];
      return row?resourceFrom(row):null;
    },
    async claim(id,resourceId,serviceId,token,allowTracking) {
      const row=(await client.query<ResourceRow>(`UPDATE inbound_document_resources r SET lease_token=$4,lease_expires_at=clock_timestamp()+interval '45 seconds',attempt_count=CASE WHEN attempt_count>=3 THEN 1 ELSE attempt_count+1 END
        FROM inbound_messages i WHERE i.id=r.inbound_message_id AND i.document_revision=r.document_revision AND ${authorized} AND r.id=$2
        AND (r.lease_token IS NULL OR r.lease_expires_at<=clock_timestamp()) AND r.available_at<=clock_timestamp()
        AND (r.state IN ('PREPARING','RETRYABLE','READY') OR ($5 AND r.state='BLOCKED' AND r.reason_code='TRACKING_RISK'))
        RETURNING r.*,r.document_revision::text`,[id,resourceId,serviceId,token,allowTracking])).rows[0];
      return row?resourceFrom(row):null;
    },
    async store(id,resourceId,serviceId,token,value,maximumBytes) {
      const owner=await client.query(`SELECT i.id FROM inbound_messages i WHERE ${authorized.replace("$3","$2")} FOR UPDATE`,[id,serviceId]);
      if(!owner.rowCount)return false;
      const saved=await client.query(`UPDATE inbound_document_resources r SET cached_content=$5,sha256=$6,content_type=$7,size_bytes=$8,scan_policy=$9,state='READY',reason_code=NULL,lease_token=NULL,lease_expires_at=NULL
        FROM inbound_messages i WHERE i.id=r.inbound_message_id AND i.document_revision=r.document_revision AND ${authorized} AND r.id=$2 AND r.lease_token=$4 AND r.lease_expires_at>clock_timestamp()
        AND $8::bigint+COALESCE((SELECT sum(size_bytes) FROM inbound_document_resources other WHERE other.inbound_message_id=i.id AND other.id<>r.id AND other.cached_content IS NOT NULL),0)<=$10
        RETURNING r.id`,[id,resourceId,serviceId,token,value.cached,value.sha256,value.contentType,value.size,value.scanPolicy,maximumBytes]);
      return !!saved.rowCount;
    },
    async fail(id,resourceId,token,reason) {
      const retryable=["FETCH_FAILED","SCAN_PENDING","NOT_READY"].includes(reason);
      await client.query(`UPDATE inbound_document_resources SET state=CASE WHEN $5 THEN 'RETRYABLE' ELSE 'UNAVAILABLE' END,reason_code=$4,available_at=clock_timestamp()+CASE WHEN attempt_count>=3 THEN interval '5 minutes' ELSE interval '30 seconds' END,lease_token=NULL,lease_expires_at=NULL WHERE inbound_message_id=$1 AND id=$2 AND lease_token=$3`,[id,resourceId,token,reason,retryable]);
    },
    async audit(id,serviceId,oldRevision,newRevision){await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES($1,'inbound.document_reprojected','inbound_message',$2,$3)",[serviceId,id,{oldRevision,newRevision}]);},
  };
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
    } else if(item.state==="READY"&&row.scan_policy!==scanPolicy().version) {item.state="PREPARING";item.reasonCode="SCAN_PENDING";}
    return inboundDocumentResourceSchema.parse(item);
  });
  return {...safe.data,resources};
}
