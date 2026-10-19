import { createMessageSchema } from '@/lib/contracts';
import { adminMutation,text } from '@/server/admin-mutation';
import { sendTestMessage } from '@/modules/outbound/public';

export async function POST(request:Request) {

return adminMutation(request,async (body,actor)=>{let result:unknown=null;let status=200;
        result = await sendTestMessage({
          idempotencyKey: text(body, "idempotencyKey"),
          serviceId: text(body, "serviceId"),
          message: createMessageSchema.parse(body.message),
        }, actor);
        status = 202;
        
return {result,status};});
}
