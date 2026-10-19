import { readAdminCallbackDelivery } from '@/modules/callbacks/public';
import { getAdminSession } from '@/server/admin-auth';
export async function GET(_request:Request,context:{params:Promise<{id:string}>}){
  if(!await getAdminSession())return Response.json({error:'Unauthorized'},{status:401});
  const {id}=await context.params;const row=await readAdminCallbackDelivery(id);
  return row?Response.json(row,{headers:{'cache-control':'no-store'}}):Response.json({error:'Callback delivery not found'},{status:404});
}
