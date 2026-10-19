import { adminMutation,text } from '@/server/admin-mutation';
import { createInboundRoute } from '@/modules/inbound/public';

export async function POST(request:Request) {

return adminMutation(request,async (body,actor)=>{let result:unknown=null;let status=200;
        result = {
          id: await createInboundRoute({
            webhookEndpointId: text(body, "webhookEndpointId"),
            domainId: text(body, "domainId"),
            serviceId: text(body,"serviceId"),
          }, actor)
        };
        status = 201;
        
return {result,status};});
}
