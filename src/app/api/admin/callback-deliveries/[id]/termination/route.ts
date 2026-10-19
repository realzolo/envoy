import { adminMutation,text } from '@/server/admin-mutation';
import { terminateCallback } from '@/modules/callbacks/public';

export async function POST(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{let result:unknown=null;const status=200;
        result = await terminateCallback(text(body,"id"),actor);
        
return {result,status};},parameters);
}
