import { reprojectInboundDocument, getInboundMessage, DocumentAccessError } from "@/modules/inbound/public";
import { serviceRoute, apiProblem, readJson } from "@/server/service-api";
export const POST=serviceRoute(async(request,identity,context:{params:Promise<{id:string}>})=>{
  const input:unknown=await readJson(request,false,256);
  if(!input||typeof input!=="object"||!("expectedRevision" in input)||typeof input.expectedRevision!=="string"||!/^(?:0|[1-9][0-9]{0,18})$/.test(input.expectedRevision))return apiProblem("Invalid request",422,"A document revision is required.");
  const {id}=await context.params;
  try{await reprojectInboundDocument(id,identity.serviceId,input.expectedRevision);const message=await getInboundMessage(id,identity.serviceId);return message?Response.json(message):apiProblem("Not found",404,"Inbound message is unavailable.");}
  catch(error){if(error instanceof DocumentAccessError)return apiProblem("Document unavailable",error.status,"The reading projection could not be updated.",undefined,error.code);throw error;}
});
