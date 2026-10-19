import { adminMutation,text } from '@/server/admin-mutation';
import { replaceCallbackSecret } from '@/modules/callbacks/public';

export async function PUT(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{let result:unknown=null;const status=200;
        result = await replaceCallbackSecret(text(body, "id"), typeof body.secret === "string" && body.secret.trim() ? body.secret : undefined, actor);
        
return {result,status};},parameters);
}
