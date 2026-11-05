import { createHash } from "node:crypto";
import { sealSecret, openSecret } from "@/platform/crypto/envelope";
import { loadWebhookEndpoint } from "@/modules/channels/public";
import { serializeVerification } from "@/integrations/providers/verification";
import { createWebhookIngress } from "@/modules/inbound/application/webhook-ingress";
import { webhookRepository } from "@/modules/inbound/infrastructure/webhook.repository";
import { documentWriter, createDocumentService } from "@/modules/inbound/application/document";
import { documentRepository } from "@/modules/inbound/infrastructure/document.repository";
import { readRetainedDocumentSource } from "@/modules/inbound/infrastructure/document-source";
import { fetchDocumentImage } from "@/modules/inbound/infrastructure/document-media";
import { readAttachment, scanBytes, scanPolicy } from "@/modules/attachments/public";
import { simpleParser } from "mailparser";
import { createUnitOfWork } from "@/platform/database";
import { createId } from "@/platform/ids";
import { digest } from "@/modules/attachments/public";
import { objectStore } from "@/platform/storage/object-store";
import { registerObjectUpload } from "@/platform/storage/object-cleanup/public";
import { createInboundService } from "@/modules/inbound/application/service";
import { createInboundChanges } from "@/modules/inbound/application/changes";
import { inboundRepository } from "@/modules/inbound/infrastructure/message.repository";
import { inboundChangesRepository } from "@/modules/inbound/infrastructure/changes.read-repository";
import { createInboundManagement } from "@/modules/inbound/application/management";
import { inboundManagementRepository } from "@/modules/inbound/infrastructure/management.repository";

export const inbound = createInboundService({
  get repository() { return inboundRepository(); }, unitOfWork: createUnitOfWork(inboundRepository), id: createId,
  digest,
  prepareDocument: documentWriter({id:()=>createId("idr"),digest,seal:(value,id)=>sealSecret(value,id,1)}), uploads: { register: registerObjectUpload, put: (key, bytes, contentType) => objectStore().put(key, bytes, contentType) },
});
export const listInboundChanges = createInboundChanges(createUnitOfWork(inboundChangesRepository));
export const inboundManagement = createInboundManagement(createUnitOfWork(inboundManagementRepository), { id: createId });

export const webhookIngress = createWebhookIngress({
  loadEndpoint: loadWebhookEndpoint, unitOfWork: createUnitOfWork(webhookRepository), id: createId,
  digest: bytes => createHash("sha256").update(bytes).digest("hex"), seal: sealSecret, encodeVerification: serializeVerification,
  uploads: { register: registerObjectUpload, put: (key, bytes, contentType) => objectStore().put(key, bytes, contentType) },
});

export const inboundDocuments = createDocumentService({
  get repository(){return documentRepository();}, unitOfWork:createUnitOfWork(documentRepository),
  id:()=>createId("idr"),digest,seal:(value,id)=>sealSecret(value,id,1),open:(value,id)=>openSecret(value,id,1),
  async rawSource(key){const raw=await objectStore().get(key,25*1024*1024);const parsed=await simpleParser(Buffer.from(raw),{skipHtmlToText:true,skipTextToHtml:true,keepCidLinks:true});return {html:typeof parsed.html==="string"?parsed.html:null,text:parsed.text||null,textProvenance:!parsed.text?"UNAVAILABLE":"AUTHORED"};},
  retainedSource:readRetainedDocumentSource,
  fetchImage:fetchDocumentImage,readAttachment:async(id,messageId,serviceId)=>{try{return (await readAttachment("inbound",id,serviceId,messageId))?.bytes??null;}catch{return null;}},
  scan:async bytes=>{const policy=scanPolicy();const result=await scanBytes(bytes);return {sha256:result.sha256,status:result.status===(policy.mode==="require_clean"?"clean":"verified")?"APPROVED":result.status==="malicious"?"REJECTED":"PENDING"};},scanPolicy:()=>scanPolicy().version,
});
