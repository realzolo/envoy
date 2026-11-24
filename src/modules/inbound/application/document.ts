import type { InboundDocument,InboundDocumentResource } from "../contracts";
import { projectDocument,type DocumentSource } from "../domain/document";
export type SealedValue = { secretCiphertext: string; encryptedDek: string; keyVersion: string };
export type DocumentWrite = { html: string | null; text: string | null; document: InboundDocument; source: SealedValue | null; resources: { metadata: InboundDocumentResource; source: SealedValue | null }[] };
export type DocumentRecord = { id: string; revision: string; source: SealedValue | null; rawKey: string | null; text: string | null; document: InboundDocument | null; purged: boolean; providerIdentity:{providerType:string;accountId:string;externalId:string}|null; receipt: { id:string; providerType:string; accountId:string; externalId:string; envelope:string[]; verification:unknown } | null };

export function documentWriter(deps:{ id():string; digest(bytes:Uint8Array):string; seal(value:unknown,id:string):SealedValue }) {
  return (id:string,source:DocumentSource,revision="1",available=true):DocumentWrite=>{
    const digest=available?deps.digest(Buffer.from(JSON.stringify(source))):null;
    const projected=projectDocument(source,{revision,digest,id:deps.id,sourceAvailable:available});
    return {html:projected.html,text:projected.text,document:projected.document,source:available?deps.seal(source,`inbound-document:${id}`):null,
      resources:projected.resources.filter(item=>projected.document.resources.some(resource=>resource.id===item.id)).map(({source:resourceSource,...metadata})=>({metadata,source:resourceSource?deps.seal(resourceSource,`inbound-resource:${metadata.id}`):null}))};
  };
}
