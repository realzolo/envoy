import { query } from "@/platform/database";
import { inboundDomainAccess } from "@/modules/identity/infrastructure/authorization";
import { openSecret, sealSecret, type Envelope } from "@/platform/crypto/envelope";
import type { ReaderSource } from "@/modules/mail-reader/contracts";
import type { DocumentSource } from "../domain/document";
import { objectStore } from "@/platform/storage/object-store";
import { readRetainedDocumentSource } from "./document-source";
import type { DocumentRecord } from "../application/document";
import { simpleParser } from "mailparser";

/** Source, never a previous renderer's lossy projection. Admin and Service are distinct authorization adapters. */
export async function readInboundReaderSource(id: string, serviceId: string | null): Promise<ReaderSource | null> {
  const row=(await query<{service_id:string|null;document_source:Envelope|null;raw_mime_object_key:string|null;text_body:string|null;document_revision:string;provider_type:string;provider_account_id:string;external_message_id:string;envelope_recipients:string[];receipt_id:string|null;verification:unknown}>(`SELECT i.service_id,i.document_source,i.raw_mime_object_key,i.text_body,i.document_revision::text,pa.type AS provider_type,i.provider_account_id,i.external_message_id,i.envelope_recipients,r.id AS receipt_id,r.verification FROM inbound_messages i
    JOIN provider_accounts pa ON pa.id=i.provider_account_id
    LEFT JOIN raw_provider_events r ON r.id=i.raw_provider_event_id AND r.signature_valid AND r.replay_valid AND r.content_purged_at IS NULL AND r.raw_payload_purged_at IS NULL
    WHERE i.id=$1 AND i.status='ready' AND i.content_purged_at IS NULL AND ($2::text IS NULL OR (i.service_id=$2 AND ${inboundDomainAccess("i")}))`,[id,serviceId])).rows[0];
  if(!row)return null;
  let original:Omit<DocumentSource,"attachments"> | null=row.document_source?openSecret<DocumentSource>(row.document_source,`inbound-document:${id}`,1):null;
  const authorize=async()=>{
    const current=await query(`SELECT i.id FROM inbound_messages i WHERE i.id=$1 AND i.status='ready' AND i.content_purged_at IS NULL AND ($2::text IS NULL OR (i.service_id=$2 AND ${inboundDomainAccess("i")}))`,[id,serviceId]);
    if(!current.rowCount)throw new Error("Reading source authorization changed");
  };
  if(!original && row.raw_mime_object_key) {
    try {
      const parsed=await simpleParser(Buffer.from(await objectStore().get(row.raw_mime_object_key,25_000_000)),{skipHtmlToText:true,skipTextToHtml:true,keepCidLinks:true});
      original={html:typeof parsed.html==="string"?parsed.html:null,text:parsed.text??null,textProvenance:parsed.text?"AUTHORED":"UNAVAILABLE"};
    }catch(error){
      const code=error&&typeof error==="object"&&"code" in error?String(error.code):"";
      if(!["ENOENT","NoSuchKey","NotFound"].includes(code))throw error;
    }
  }
  if(!original) {
    const record:DocumentRecord={id,revision:row.document_revision,source:null,rawKey:row.raw_mime_object_key,text:row.text_body,document:null,purged:false,
      providerIdentity:row.external_message_id?{providerType:row.provider_type,accountId:row.provider_account_id,externalId:row.external_message_id}:null,
      receipt:row.receipt_id?{id:row.receipt_id,providerType:row.provider_type,accountId:row.provider_account_id,externalId:row.external_message_id,envelope:row.envelope_recipients,verification:row.verification}:null};
    original=await readRetainedDocumentSource(record,authorize);
  }
  await authorize();
  const recovered=!row.document_source&&original!==null;
  if(!original) original={html:null,text:row.text_body,textProvenance:"NOT_RECORDED"};
  const attachments=(await query<{id:string;content_id:string|null;content_type:string;size_bytes:string;sha256:string}>("SELECT id,content_id,content_type,size_bytes::text,sha256 FROM inbound_attachments WHERE inbound_message_id=$1 AND content_purged_at IS NULL ORDER BY id",[id])).rows;
  if(recovered) {
    const canonical={...original,attachments:attachments.map(file=>({id:file.id,contentId:file.content_id}))};
    await query(`UPDATE inbound_messages i SET document_source=$3 WHERE i.id=$1 AND i.document_source IS NULL AND i.content_purged_at IS NULL AND i.status='ready' AND ($2::text IS NULL OR (i.service_id=$2 AND ${inboundDomainAccess("i")}))`,[id,serviceId,sealSecret(canonical,`inbound-document:${id}`,1)]);
  }
  await authorize();
  return {kind:"INBOUND",id,serviceId:row.service_id,html:original.html,text:original.text,attachments:attachments.map(file=>({id:file.id,contentId:file.content_id,contentType:file.content_type,size:Number(file.size_bytes),sha256:file.sha256}))};
}
