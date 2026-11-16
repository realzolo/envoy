import { adminMutation,text } from '@/server/admin-mutation';
import { refreshIdentity } from '@/modules/channels/public';
export async function POST(request:Request, context:{params:Promise<{id:string}>}) {
  const parameters=await context.params;
  return adminMutation(request,async (body,actor)=>({result:await refreshIdentity(text(body,"id"),actor,true),status:200}),parameters);
}
