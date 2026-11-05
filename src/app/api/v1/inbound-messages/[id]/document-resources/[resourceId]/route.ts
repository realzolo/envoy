import { readInboundDocumentResource, DocumentAccessError } from "@/modules/inbound/public";
import { serviceRoute, apiProblem } from "@/server/service-api";
export const GET=serviceRoute(async(request,identity,context:{params:Promise<{id:string;resourceId:string}>})=>{
  const {id,resourceId}=await context.params;
  if(!/^[A-Za-z0-9_-]{1,200}$/.test(resourceId))return apiProblem("Not found",404,"Resource is unavailable.");
  try{const resource=await readInboundDocumentResource(id,resourceId,identity.serviceId,new URL(request.url).searchParams.get("allowTracking")==="true");return new Response(Buffer.from(resource.bytes),{headers:{"content-type":resource.contentType,"content-length":String(resource.bytes.byteLength),"x-content-sha256":resource.sha256,"x-content-type-options":"nosniff","cache-control":"private, no-store","content-security-policy":"sandbox"}});}
  catch(error){if(error instanceof DocumentAccessError)return apiProblem("Resource unavailable",error.status,"This image is not currently available.",undefined,error.code);throw error;}
});
