import { attachmentUsage } from '@/modules/attachments/public';
import { readAdminInboundDetail } from '@/modules/inbound/public';
import { getAdminSession } from '@/server/admin-auth';
export async function GET(_request:Request,context:{params:Promise<{id:string}>}){
  if(!await getAdminSession())return Response.json({error:'Unauthorized'},{status:401});
  const {id}=await context.params;
  const detail=await readAdminInboundDetail(id);
  if(!detail)return Response.json({error:'Inbound message not found'},{status:404});
  const {message,attachments}=detail;
  return Response.json({...message,attachments:attachments.map(file=>{const usage=attachmentUsage(!file.content_purged_at,file.sha256,file.safety,'inbound');return {...file,usage,downloadable:message.status==='ready'&&usage.canDownload};})},{headers:{'cache-control':'no-store'}});
}
