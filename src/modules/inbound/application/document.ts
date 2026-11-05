import type { InboundDocument, InboundDocumentResource, InboundResourceReason } from "../contracts";
import { DOCUMENT_POLICY_VERSION, MAX_DOCUMENT_IMAGE_BYTES, projectDocument, type DocumentSource, type ResourceSource } from "../domain/document";
import { bitmapInfo, DocumentResourceError } from "../domain/bitmap";
import type { UnitOfWork } from "@/platform/transactions";

export type SealedValue = { secretCiphertext: string; encryptedDek: string; keyVersion: string };
export type DocumentWrite = { html: string | null; text: string | null; document: InboundDocument; source: SealedValue | null; resources: { metadata: InboundDocumentResource; source: SealedValue | null }[] };
export type DocumentRecord = { id: string; revision: string; source: SealedValue | null; rawKey: string | null; text: string | null; document: InboundDocument | null; purged: boolean; providerIdentity:{providerType:string;accountId:string;externalId:string}|null; receipt: { id:string; providerType:string; accountId:string; externalId:string; envelope:string[]; verification:unknown } | null };
export type ResourceRecord = { metadata: InboundDocumentResource; source: SealedValue | null; cached: SealedValue | null; sha256: string | null; scanPolicy: string | null; revision: string; token: string | null };
export interface DocumentRepository {
  read(id: string, serviceId: string): Promise<DocumentRecord | null>;
  attachments(id: string): Promise<{id:string;contentId:string|null}[]>;
  publish(id: string, serviceId: string, expected: string, write: DocumentWrite): Promise<boolean>;
  resource(id: string, resourceId: string, serviceId: string): Promise<ResourceRecord | null>;
  claim(id: string, resourceId: string, serviceId: string, token: string, allowTracking: boolean): Promise<ResourceRecord | null>;
  store(id: string, resourceId: string, serviceId: string, token: string, value: {cached:SealedValue;sha256:string;contentType:string;size:number;scanPolicy:string}, maximumBytes: number): Promise<boolean>;
  fail(id: string, resourceId: string, token: string, reason: InboundResourceReason): Promise<void>;
  audit(id: string, serviceId: string, oldRevision: string, newRevision: string): Promise<void>;
}
export interface DocumentDependencies {
  repository: DocumentRepository; unitOfWork: UnitOfWork<DocumentRepository>;
  id():string; digest(bytes: Uint8Array):string;
  seal(value:unknown,id:string):SealedValue; open<T>(value:SealedValue,id:string):T;
  rawSource(key:string):Promise<Omit<DocumentSource,"attachments">>;
  retainedSource(record:DocumentRecord,authorize:()=>Promise<void>):Promise<Omit<DocumentSource,"attachments">|null>;
  fetchImage(url:string,authorize:()=>Promise<void>):Promise<Uint8Array>;
  readAttachment(id:string,messageId:string,serviceId:string):Promise<Uint8Array|null>;
  scan(bytes:Uint8Array):Promise<{status:"APPROVED"|"REJECTED"|"PENDING";sha256:string}>; scanPolicy():string;
}
export class DocumentAccessError extends Error { constructor(readonly status: 404|409, readonly code: string) {super(code);} }
let activeMedia=0;
let activeReprojections=0;
export const MAX_CONCURRENT_DOCUMENT_REPROJECTIONS=2;
export const MAX_CONCURRENT_DOCUMENT_MEDIA=3;

export function documentWriter(deps:Pick<DocumentDependencies,"id"|"digest"|"seal">) {
  return (id:string,source:DocumentSource,revision="1",available=true):DocumentWrite=>{
    const digest=available?deps.digest(Buffer.from(JSON.stringify(source))):null;
    const projected=projectDocument(source,{revision,digest,id:deps.id,sourceAvailable:available});
    return {html:projected.html,text:projected.text,document:projected.document,source:available?deps.seal(source,`inbound-document:${id}`):null,
      resources:projected.resources.filter(item=>projected.document.resources.some(resource=>resource.id===item.id)).map(({source:resourceSource,...metadata})=>({metadata,source:resourceSource?deps.seal(resourceSource,`inbound-resource:${metadata.id}`):null}))};
  };
}

export function createDocumentService(deps:DocumentDependencies) {
  const write=documentWriter(deps);
  const authorize=async(id:string,serviceId:string,revision?:string)=>{
    const record=await deps.repository.read(id,serviceId);
    if(!record||record.purged||(revision!==undefined&&record.revision!==revision))throw new DocumentAccessError(404,"DOCUMENT_UNAVAILABLE");
    return record;
  };
  return {
    async reproject(id:string,serviceId:string,expectedRevision:string) {
      const record=await authorize(id,serviceId);
      if(record.revision!==expectedRevision)throw new DocumentAccessError(409,"DOCUMENT_REVISION_CONFLICT");
      // Repeated demand for the same policy is idempotent, including unavailable historical sources.
      if(record.document?.policyVersion===DOCUMENT_POLICY_VERSION)return;
      if(activeReprojections>=MAX_CONCURRENT_DOCUMENT_REPROJECTIONS)throw new DocumentAccessError(409,"DOCUMENT_PREPARING");
      activeReprojections++;
      try {
      let source:DocumentSource|null=null;
      if(record.source)source=deps.open<DocumentSource>(record.source,`inbound-document:${id}`);
      else if(record.rawKey){try {source={...await deps.rawSource(record.rawKey),attachments:await deps.repository.attachments(id)};}catch(error){
        const code=error&&typeof error==="object"&&"code" in error?String(error.code):error instanceof Error?error.name:"";
        if(!["ENOENT","NoSuchKey","NotFound"].includes(code))throw new DocumentAccessError(409,"DOCUMENT_PREPARING");
      }}
      if(!source && record.providerIdentity) {
        const restored=await deps.retainedSource(record,()=>authorize(id,serviceId,record.revision).then(()=>{}));
        if(restored)source={...restored,attachments:await deps.repository.attachments(id)};
      }
      const next=(BigInt(record.revision)+BigInt(1)).toString();
      const projection=write(id,source??{html:null,text:record.text,textProvenance:record.text===null?"UNAVAILABLE":"NOT_RECORDED",attachments:[]},next,!!source);
      await deps.unitOfWork.run(async repo=>{
        if(!await repo.publish(id,serviceId,expectedRevision,projection))throw new DocumentAccessError(409,"DOCUMENT_REVISION_CONFLICT");
        await repo.audit(id,serviceId,expectedRevision,next);
      });
      } finally {activeReprojections--;}
    },
    async readResource(id:string,resourceId:string,serviceId:string,allowTracking=false) {
      const existing=await deps.repository.resource(id,resourceId,serviceId);
      if(!existing)throw new DocumentAccessError(404,"RESOURCE_UNAVAILABLE");
      const authorization=()=>authorize(id,serviceId,existing.revision).then(()=>{});
      const validated=async(bytes:Uint8Array)=>{
        const info=bitmapInfo(bytes);await authorization();
        return {bytes,contentType:info.contentType,sha256:deps.digest(bytes)};
      };
      // CID keeps the existing attachment scanner/ownership/purge boundary; no alternate private-key read.
      if(existing.metadata.kind==="CID") {
        if(!existing.metadata.attachmentId)throw new DocumentAccessError(409,"RESOURCE_UNAVAILABLE");
        const bytes=await deps.readAttachment(existing.metadata.attachmentId,id,serviceId);
        if(!bytes)throw new DocumentAccessError(409,"RESOURCE_UNAVAILABLE");
        return validated(bytes);
      }
      if(existing.metadata.state==="READY"&&existing.cached&&existing.scanPolicy===deps.scanPolicy()) {
        const cached=deps.open<{base64:string}>(existing.cached,`inbound-resource-cache:${resourceId}`);
        const result=await validated(Buffer.from(cached.base64,"base64"));
        if(result.sha256!==existing.sha256 || existing.scanPolicy!==deps.scanPolicy())throw new DocumentAccessError(409,"RESOURCE_UNAVAILABLE");
        return result;
      }
      if(activeMedia>=MAX_CONCURRENT_DOCUMENT_MEDIA)throw new DocumentAccessError(409,"RESOURCE_PREPARING");
      activeMedia++;
      const token=deps.id();
      try {
        const claimed=await deps.repository.claim(id,resourceId,serviceId,token,allowTracking);
        if(!claimed)throw new DocumentAccessError(409,"RESOURCE_PREPARING");
        const source=claimed.source?deps.open<ResourceSource>(claimed.source,`inbound-resource:${resourceId}`):null;
        // Scanner policy changes re-verify retained encrypted bytes, without contacting the sender again.
        const retained=claimed.cached?Buffer.from(deps.open<{base64:string}>(claimed.cached,`inbound-resource-cache:${resourceId}`).base64,"base64"):null;
        if(retained&&deps.digest(retained)!==claimed.sha256)throw new DocumentResourceError("SCAN_REJECTED");
        const bytes=retained??(source?.base64?Buffer.from(source.base64,"base64"):source?.url?await deps.fetchImage(source.url,authorization):null);
        if(!bytes)throw new DocumentResourceError("SOURCE_UNAVAILABLE");
        const result=await validated(bytes),policy=deps.scanPolicy(),scan=await deps.scan(bytes);
        if(scan.status!=="APPROVED")throw new DocumentResourceError(scan.status==="REJECTED"?"SCAN_REJECTED":"SCAN_PENDING");
        if(scan.sha256!==result.sha256||policy!==deps.scanPolicy())throw new DocumentResourceError("SCAN_PENDING");
        const stored=await deps.unitOfWork.run(repo=>repo.store(id,resourceId,serviceId,token,{cached:deps.seal({base64:Buffer.from(bytes).toString("base64")},`inbound-resource-cache:${resourceId}`),sha256:result.sha256,contentType:result.contentType,size:bytes.byteLength,scanPolicy:policy},MAX_DOCUMENT_IMAGE_BYTES));
        if(!stored)throw new DocumentResourceError("RESOURCE_LIMIT");
        await authorization();return result;
      } catch(error) {
        if(!(error instanceof DocumentAccessError))await deps.repository.fail(id,resourceId,token,error instanceof DocumentResourceError?error.reason:"FETCH_FAILED");
        if(error instanceof DocumentAccessError)throw error;
        throw new DocumentAccessError(409,"RESOURCE_UNAVAILABLE");
      } finally {activeMedia--;}
    },
  };
}
