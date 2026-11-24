import { mailReader } from "@/modules/mail-reader/public";
import { resolveOutboundReaderDelivery } from "@/modules/outbound/sources";
import { serviceRoute,readJson,apiProblem } from "@/server/service-api";
import { readerOrigin,readerProblem,READER_HEADERS } from "@/server/mail-reader";
export const POST=serviceRoute(async(request,identity,context:{params:Promise<{id:string}>})=>{
 const body=await readJson(request,false,2048);
 if(!body||typeof body!=="object"||!("recipient" in body)||typeof body.recipient!=="string"||body.recipient.length>320)return apiProblem("Invalid request",422,"A recipient is required.");
 const id=await resolveOutboundReaderDelivery((await context.params).id,body.recipient,identity.serviceId);
 if(!id)return Response.json({code:"READING_UNAVAILABLE"},{status:404,headers:READER_HEADERS});
 try{return Response.json(await mailReader.issue({kind:"OUTBOUND",id,serviceId:identity.serviceId},readerOrigin(request)),{headers:READER_HEADERS});}catch(error){return readerProblem(error);}
});
