import { adminMutation,text } from '@/server/admin-mutation';
import { replayRawEvent } from '@/modules/inbound/public';

export async function POST(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{const result:unknown=null;let status=200;
        await replayRawEvent(text(body, "id"), actor);
        status = 202;
        
return {result,status};},parameters);
}
