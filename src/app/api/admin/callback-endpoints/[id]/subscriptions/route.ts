import { adminMutation,strings,text } from '@/server/admin-mutation';
import { updateCallback } from '@/modules/callbacks/public';

export async function PUT(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{const result:unknown=null;const status=200;
        await updateCallback(text(body,"id"), { events:strings(body.events) },actor);
        
return {result,status};},parameters);
}
