import { adminMutation,text } from '@/server/admin-mutation';
import { issueServiceCredential } from '@/modules/identity/public';

export async function POST(request:Request, context:{params:Promise<{id:string}>}) {
const {id}=await context.params;
return adminMutation(request,async (body,actor)=>{let result:unknown=null;let status=200;
        result = await issueServiceCredential(text(body, "serviceId"), actor);
        status=201;
        
return {result,status};},{serviceId:id});
}
