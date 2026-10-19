import { adminMutation,text } from '@/server/admin-mutation';
import { terminateRawEvent } from '@/modules/inbound/public';

export async function POST(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{const result:unknown=null;const status=200;
        await terminateRawEvent(text(body,"id"),actor);
        
return {result,status};},parameters);
}
