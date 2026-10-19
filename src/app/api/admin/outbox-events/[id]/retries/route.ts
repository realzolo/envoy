import { adminMutation,text } from '@/server/admin-mutation';
import { retryOutbox } from '@/platform/outbox/public';

export async function POST(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{let result:unknown=null;let status=200;
        result = await retryOutbox(text(body,"id"),actor);
        status=202;
        
return {result,status};},parameters);
}
