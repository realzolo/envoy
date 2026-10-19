import { adminMutation,text } from '@/server/admin-mutation';
import { simulateRouting } from '@/modules/outbound/public';

export async function POST(request:Request) {

return adminMutation(request,async (body)=>{let result:unknown=null;const status=200;
        result = await simulateRouting({
          domainId: text(body, "domainId"),
          productId: typeof body.productId === "string" ? body.productId : undefined,
          serviceId: typeof body.serviceId === "string" ? body.serviceId : undefined,
          category: typeof body.category === "string" ? body.category : undefined
        });
        
return {result,status};});
}
