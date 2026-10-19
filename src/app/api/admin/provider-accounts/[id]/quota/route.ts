import { adminMutation,object,text } from '@/server/admin-mutation';
import { updateProviderQuota } from '@/modules/channels/public';

export async function PUT(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{const result:unknown=null;const status=200;
        await updateProviderQuota(text(body, "id"), object(body, "quota"), actor);
        
return {result,status};},parameters);
}
