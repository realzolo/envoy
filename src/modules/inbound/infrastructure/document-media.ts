import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isPrivateOrReservedAddress } from "@/platform/network-address";
import { MAX_IMAGE_BYTES } from "../domain/document";
import { DocumentResourceError } from "../domain/bitmap";

export const MEDIA_EXECUTION_TIMEOUT_MS = 10_000;
export const MAX_MEDIA_REDIRECTS = 3;
export type MediaResolver = (host: string) => Promise<{address:string;family:number}[]>;
export async function mediaTarget(raw: string, resolver: MediaResolver = host => lookup(host,{all:true,verbatim:true})) {
  let url: URL;
  try { url=new URL(raw); } catch { throw new DocumentResourceError("NETWORK_BLOCKED"); }
  if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.href.length>8192||!["","80","443"].includes(url.port))throw new DocumentResourceError("NETWORK_BLOCKED");
  const host=url.hostname.replace(/^\[|\]$/g,"").replace(/\.$/,"");
  const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await resolver(host);
  // All answers must be public. This path never inherits the development callback private-host override.
  if(!addresses.length||addresses.some(item=>isIP(item.address)!==item.family||![4,6].includes(item.family)||(isPrivateOrReservedAddress(item.address) || (item.family===6 && (!/^[23][0-9a-f]{3}:/i.test(item.address) || /^2002:/i.test(item.address) || /^3fff:/i.test(item.address) || /^2001:0*(?:[0-9a-f]{1,2}|1[0-9a-f]{2}):/i.test(item.address))))))throw new DocumentResourceError("NETWORK_BLOCKED");
  return {url,addresses};
}

/** Fixed manifest URL only; DNS pinned, every redirect revalidated, no ambient credentials or cookies. */
export async function fetchDocumentImage(raw: string, authorize: () => Promise<void>, resolver?: MediaResolver, timeoutMs = MEDIA_EXECUTION_TIMEOUT_MS): Promise<Uint8Array> {
  const controller=new AbortController(); let timer: ReturnType<typeof setTimeout>;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new DocumentResourceError("FETCH_FAILED"));},timeoutMs);});
  try { return await Promise.race([deadline,(async()=>{
    let current=raw;
    for(let redirect=0;redirect<=MAX_MEDIA_REDIRECTS;redirect++) {
      controller.signal.throwIfAborted();
      const target=await mediaTarget(current,resolver);controller.signal.throwIfAborted();
      const result=await new Promise<{bytes?:Uint8Array;location?:string}>((resolve,reject)=>{
        const transport=target.url.protocol==="https:"?httpsRequest:httpRequest;
        const pinned=((_host: string, options: {all?:boolean;family?:number}, cb: (error:Error|null,address:unknown,family?:number)=>void)=>{
          const selected=target.addresses.filter(item=>!options.family||options.family===item.family);const list=selected.length?selected:target.addresses;
          if(options.all)cb(null,list);else cb(null,list[0].address,list[0].family);
        }) as LookupFunction;
        const request=transport(target.url,{method:"GET",agent:false,lookup:pinned,signal:controller.signal,headers:{accept:"image/png,image/jpeg,image/gif,image/webp","accept-encoding":"identity","user-agent":"Envoy-Mail-Media/1"}},response=>{
          const status=response.statusCode??0;
          if([301,302,303,307,308].includes(status)&&response.headers.location){response.destroy();resolve({location:response.headers.location});return;}
          if(status<200||status>=300){response.destroy();reject(new DocumentResourceError("FETCH_FAILED"));return;}
          if(response.headers["content-encoding"]&&response.headers["content-encoding"]!=="identity"){response.destroy();reject(new DocumentResourceError("UNSUPPORTED_TYPE"));return;}
          const length=Number(response.headers["content-length"]??0);
          if(length>MAX_IMAGE_BYTES){response.destroy();reject(new DocumentResourceError("SIZE_LIMIT"));return;}
          let size=0;const chunks:Buffer[]=[];
          response.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_IMAGE_BYTES){response.destroy();reject(new DocumentResourceError("SIZE_LIMIT"));}else chunks.push(chunk);});
          response.on("end",()=>resolve({bytes:new Uint8Array(Buffer.concat(chunks))}));response.on("error",reject);
        });
        request.on("error",reject);
        request.once("socket",socket=>socket.once(target.url.protocol==="https:"?"secureConnect":"connect",()=>{
          // Recheck the full frozen ownership after DNS/TLS waits, immediately before network write.
          void authorize().then(()=>{controller.signal.throwIfAborted();request.end();}).catch(error=>request.destroy(error instanceof Error?error:undefined));
        }));
      });
      if(result.bytes)return result.bytes;
      if(!result.location||redirect===MAX_MEDIA_REDIRECTS)throw new DocumentResourceError("FETCH_FAILED");
      current=new URL(result.location,target.url).href;
    }
    throw new DocumentResourceError("FETCH_FAILED");
  })()]); } catch(error) {if(error instanceof DocumentResourceError)throw error;throw new DocumentResourceError("FETCH_FAILED");}
  finally{clearTimeout(timer!);controller.abort();}
}
