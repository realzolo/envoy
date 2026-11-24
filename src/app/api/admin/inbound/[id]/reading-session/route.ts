import { mailReader } from "@/modules/mail-reader/public";
import { getAdminSession } from "@/server/admin-auth";
import { readerOrigin,readerProblem,READER_HEADERS } from "@/server/mail-reader";
export async function POST(request:Request,context:{params:Promise<{id:string}>}) {
 if(!await getAdminSession())return Response.json({error:"Unauthorized"},{status:401,headers:READER_HEADERS});
 try{return Response.json(await mailReader.issue({kind:"INBOUND",id:(await context.params).id,serviceId:null},readerOrigin(request)),{headers:READER_HEADERS});}
 catch(error){return readerProblem(error);}
}
