import { adminMutation,object,text } from '@/server/admin-mutation';
import { rotateProviderCredential } from '@/modules/channels/public';

export async function POST(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{let result:unknown=null;const status=200;
        result = await rotateProviderCredential(text(body, "id"), object(body, "secret"), actor);
        
return {result,status};},parameters);
}
