import { adminMutation,text } from '@/server/admin-mutation';
import { createProduct } from '@/modules/identity/public';

export async function POST(request:Request) {

return adminMutation(request,async (body,actor)=>{let result:unknown=null;let status=200;
        result = {
          id: await createProduct({
            name: text(body, "name")
          }, actor)
        };
        status = 201;
        
return {result,status};});
}
