import { adminMutation,text } from '@/server/admin-mutation';
import { toggleCallback } from '@/modules/callbacks/public';

export async function PATCH(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{const result:unknown=null;const status=200;
        await toggleCallback(text(body, "id"), body.enabled === true, actor);
        
return {result,status};},parameters);
}
