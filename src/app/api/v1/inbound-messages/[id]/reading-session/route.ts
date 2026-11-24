import { mailReader } from "@/modules/mail-reader/public";
import { serviceRoute } from "@/server/service-api";
import { readerOrigin,readerProblem,READER_HEADERS } from "@/server/mail-reader";
export const POST=serviceRoute(async(request,identity,context:{params:Promise<{id:string}>})=>{
 try {return Response.json(await mailReader.issue({kind:"INBOUND",id:(await context.params).id,serviceId:identity.serviceId},readerOrigin(request)),{headers:READER_HEADERS});}
 catch(error){return readerProblem(error);}
});
