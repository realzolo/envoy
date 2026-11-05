import type { LookupFunction } from "node:net";
import { mediaTarget } from "./document-media";
import { request } from "node:https";
import { simpleParser } from "mailparser";
import { openSecret, type Envelope } from "@/platform/crypto/envelope";
import { objectStore } from "@/platform/storage/object-store";
import { loadProviderAccount } from "@/modules/channels/public";
import { restoreVerification } from "@/integrations/providers/verification";
import { providerRegistry } from "@/integrations/providers/public";
import type { ProviderType } from "@/integrations/providers/contracts";
import { address } from "../domain/message";
import type { DocumentSource } from "../domain/document";
import { DocumentAccessError, type DocumentRecord } from "../application/document";

const RETAINED_SOURCE_TIMEOUT_MS=10_000;
const MAX_SOURCE_RESPONSE_BYTES=8_400_000;
/** Fixed native provider path; credentials never go to an HTML supplied URL or a redirect. */
async function resendBody(externalId:string,apiKey:string,authorize:()=>Promise<void>):Promise<Record<string,unknown>|null> {
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new DocumentAccessError(409,"DOCUMENT_PREPARING"));},RETAINED_SOURCE_TIMEOUT_MS);});
  try {return await Promise.race([deadline,(async()=>{
    const target=await mediaTarget(`https://api.resend.com/emails/receiving/${encodeURIComponent(externalId)}?html_format=cid`);
    controller.signal.throwIfAborted();
    return new Promise<Record<string,unknown>|null>((resolve,reject)=>{
      const pinned=((_host:string,options:{all?:boolean;family?:number},callback:(error:Error|null,address:unknown,family?:number)=>void)=>{const matching=target.addresses.filter(item=>!options.family||options.family===item.family),addresses=matching.length?matching:target.addresses;if(options.all)callback(null,addresses);else callback(null,addresses[0].address,addresses[0].family);}) as LookupFunction;
      const req=request(target.url,{method:"GET",agent:false,signal:controller.signal,lookup:pinned,headers:{authorization:`Bearer ${apiKey}`,accept:"application/json","accept-encoding":"identity"}},res=>{
        if(res.statusCode===404||res.statusCode===410){res.destroy();resolve(null);return;}
        if(res.statusCode!==200||res.headers["content-encoding"]&&res.headers["content-encoding"]!=="identity"){res.destroy();reject(new DocumentAccessError(409,"DOCUMENT_PREPARING"));return;}
        const chunks:Buffer[]=[];let size=0;
        res.on("data",(part:Buffer)=>{size+=part.length;if(size>MAX_SOURCE_RESPONSE_BYTES)res.destroy(new DocumentAccessError(409,"DOCUMENT_PREPARING"));else chunks.push(part);});
        res.on("error",reject);res.on("end",()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string,unknown>);}catch{reject(new DocumentAccessError(409,"DOCUMENT_PREPARING"));}});
      });
      req.on("error",reject);
      req.once("socket",socket=>socket.once("secureConnect",()=>{void authorize().then(()=>{controller.signal.throwIfAborted();req.end();}).catch(error=>req.destroy(error instanceof Error?error:undefined));}));
    });
  })()]);} finally{clearTimeout(timer!);controller.abort();}
}

async function resendDocumentSource(record:DocumentRecord,authorize:()=>Promise<void>):Promise<Omit<DocumentSource,"attachments">|null> {
  const identity=record.providerIdentity;if(!identity)return null;
  const account=await loadProviderAccount(identity.accountId);
  if(account.context.secret.type!=="resend")return null;
  const apiKey=account.context.secret.apiKey;
  const body=await resendBody(identity.externalId,apiKey,async()=>{await authorize();const current=await loadProviderAccount(identity.accountId);if(current.context.secret.type!=="resend"||current.context.secret.apiKey!==apiKey)throw new DocumentAccessError(409,"DOCUMENT_PREPARING");});
  if(!body)return null;if(body.id!==identity.externalId)throw new DocumentAccessError(409,"DOCUMENT_PREPARING");
  await authorize();
  return {html:typeof body.html==="string"?body.html:null,text:typeof body.text==="string"&&body.text?body.text:null,textProvenance:typeof body.text==="string"&&body.text?"NOT_RECORDED":"UNAVAILABLE"};
}
export async function readRetainedDocumentSource(record:DocumentRecord,authorize:()=>Promise<void>):Promise<Omit<DocumentSource,"attachments">|null> {
  const receipt=record.receipt;if(!receipt)return record.providerIdentity?.providerType==="resend"?resendDocumentSource(record,authorize):null;
  const reference=receipt.verification as {objectKey?:unknown};
  let envelope:Envelope;
  try {envelope=typeof reference?.objectKey==="string"?JSON.parse(Buffer.from(await objectStore().get(reference.objectKey,50_000_000)).toString("utf8")):reference as Envelope;}
  catch(error){const code=error&&typeof error==="object"&&"code" in error?String(error.code):error instanceof Error?error.name:"";if(["ENOENT","NoSuchKey","NotFound"].includes(code))return record.providerIdentity?.providerType==="resend"?resendDocumentSource(record,authorize):null;throw new DocumentAccessError(409,"DOCUMENT_PREPARING");}
  await authorize();
  const verified=restoreVerification(openSecret(envelope,`provider-receipt:${receipt.id}`,1));
  const provider=providerRegistry(receipt.providerType as ProviderType),routing=provider.inbound?.routingReceipt(verified);
  if(!verified.valid||!verified.replaySafe||!routing||routing.externalMessageId!==receipt.externalId||record.receipt!.envelope.some(item=>!routing.envelopeRecipients?.map(address).includes(address(item))))return null;
  const payload=verified.parsed as Record<string,unknown>;
  let html:unknown=null,text:unknown=null,authored=false;
  if(receipt.providerType==="postmark"){html=payload.HtmlBody;text=payload.TextBody;}
  else if(receipt.providerType==="sendgrid"||receipt.providerType==="mailgun") {
    const mime=typeof payload.email==="string"?payload.email:typeof payload["body-mime"]==="string"?payload["body-mime"]:null;
    if(mime){const parsed=await simpleParser(mime,{skipHtmlToText:true,skipTextToHtml:true,keepCidLinks:true});html=parsed.html;text=parsed.text;authored=true;}
    else if(receipt.providerType==="sendgrid"){html=payload.html;text=payload.text;}
    else {html=Array.isArray(payload["body-html"])?payload["body-html"].filter(item=>typeof item==="string").join("\n"):payload["body-html"];text=payload["body-plain"];}
  } else if(receipt.providerType==="resend") return resendDocumentSource(record,authorize);
  else return null;
  await authorize();
  return {html:typeof html==="string"?html:null,text:typeof text==="string"&&text?text:null,textProvenance:typeof text==="string"&&text?(authored?"AUTHORED":"NOT_RECORDED"):"UNAVAILABLE"};
}
