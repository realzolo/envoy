import { adminMutation,text } from '@/server/admin-mutation';
import { addSuppression } from '@/modules/suppressions/public';

export async function POST(request:Request) {

return adminMutation(request,async (body,actor)=>{let result:unknown=null;let status=200;
        result = {
          id: await addSuppression({
            email: text(body, "email"),
            scope: text(body, "scope") as "global" | "service" | "list",
            serviceId: typeof body.serviceId === "string" ? body.serviceId : undefined,
            listId: typeof body.listId === "string" ? body.listId : undefined,
            reason: text(body, "reason"),
            expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined
          }, actor)
        };
        status = 201;
        
return {result,status};});
}
