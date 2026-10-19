import { adminMutation,object,text } from '@/server/admin-mutation';
import { configureProviderWebhook } from '@/modules/channels/public';

export async function PUT(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{let result:unknown=null;const status=200;
        result = await configureProviderWebhook(text(body, "id"), object(body, "settings"), actor);
        
return {result,status};},parameters);
}
