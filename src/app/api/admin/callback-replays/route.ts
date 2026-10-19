import { adminMutation } from '@/server/admin-mutation';
import { replayDeadLetters } from '@/modules/callbacks/public';

export async function POST(request:Request) {

return adminMutation(request,async (body,actor)=>{let result:unknown=null;let status=200;
        result = { count: await replayDeadLetters(actor, { endpointId: typeof body.endpointId === "string" ? body.endpointId : undefined, deliveryId: typeof body.deliveryId === "string" ? body.deliveryId : undefined }) };
        status = 202;
        
return {result,status};});
}
