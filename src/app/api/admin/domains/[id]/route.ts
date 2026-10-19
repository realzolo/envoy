import { adminMutation,text } from '@/server/admin-mutation';
import { toggleDomain } from '@/modules/channels/public';

export async function PATCH(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{const result:unknown=null;const status=200;
        await toggleDomain(text(body, "id"), body.enabled === true, actor);
        
return {result,status};},parameters);
}
