import { adminMutation,text } from '@/server/admin-mutation';
import { manualRetryDelivery } from '@/modules/outbound/public';

export async function POST(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{let result:unknown=null;let status=200;
        result = await manualRetryDelivery(text(body, "id"), body.acknowledgeDuplicateRisk === true, actor);
        status = 202;
        
return {result,status};},parameters);
}
