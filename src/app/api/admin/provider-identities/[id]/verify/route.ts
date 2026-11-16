import { adminMutation,text } from '@/server/admin-mutation';
import { verifyIdentity } from '@/modules/channels/public';
export async function POST(request:Request, context:{params:Promise<{id:string}>}) {
  const parameters=await context.params;
  return adminMutation(request,async (body,actor)=>({result:await verifyIdentity(text(body,"id"),actor),status:200}),parameters);
}
