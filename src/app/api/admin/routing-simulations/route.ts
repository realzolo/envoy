import { adminMutation,text } from '@/server/admin-mutation';
import { simulateRouting } from '@/modules/outbound/public';

export async function POST(request:Request) {

return adminMutation(request,async (body)=>{let result:unknown=null;const status=200;
        result = await simulateRouting({
          domainId: text(body, "domainId"),
          serviceId: typeof body.serviceId === "string" ? body.serviceId : undefined,
          category: typeof body.category === "string" ? body.category : undefined
        });
        
return {result,status};});
}
