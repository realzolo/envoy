import { mailReader } from "@/modules/mail-reader/public";
import { readerProblem,READER_HEADERS } from "@/server/mail-reader";
export async function GET(_request:Request,context:{params:Promise<{token:string;resourceId:string}>}) {
 try{const {token,resourceId}=await context.params;if(!/^resource_[1-9][0-9]{0,3}$/.test(resourceId))return Response.json({code:"READING_RESOURCE_UNAVAILABLE"},{status:404,headers:READER_HEADERS});
 const image=await mailReader.readResource(token,resourceId);return new Response(Buffer.from(image.bytes),{headers:{...READER_HEADERS,"content-type":image.contentType,"content-length":String(image.bytes.length),"content-security-policy":"sandbox","x-content-sha256":image.sha256}});
 }catch(error){return readerProblem(error);}
}
