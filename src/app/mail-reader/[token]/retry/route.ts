import { mailReader } from "@/modules/mail-reader/public";
import { readerProblem,READER_HEADERS } from "@/server/mail-reader";
import { readRequestBytes } from "@/server/request-body";
const headers={...READER_HEADERS,"access-control-allow-methods":"POST, OPTIONS","access-control-allow-headers":"content-type"};
export function OPTIONS(){return new Response(null,{status:204,headers});}
export async function POST(request:Request,context:{params:Promise<{token:string}>}) {
 let body:unknown;
 try{body=JSON.parse(new TextDecoder().decode(await readRequestBytes(request,1024)));}catch{return Response.json({code:"READING_INVALID_RETRY"},{status:422,headers});}
 if(!body||typeof body!=="object"||!("operationId" in body)||typeof body.operationId!=="string"||!/^[A-Za-z0-9_-]{16,128}$/.test(body.operationId))return Response.json({code:"READING_INVALID_RETRY"},{status:422,headers});
 try{return Response.json(await mailReader.retry((await context.params).token,body.operationId),{headers});}catch(error){return readerProblem(error);}
}
