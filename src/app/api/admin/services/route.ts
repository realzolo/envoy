import { adminMutation,object } from '@/server/admin-mutation';
import { createService } from '@/modules/identity/public';

export async function POST(request:Request) {

return adminMutation(request,async (body,actor)=>{let result:unknown=null;let status=200;
        result = await createService(object(body, "configuration"), actor);
        status = 201;
        
return {result,status};});
}
