import { adminMutation,strings,text } from '@/server/admin-mutation';
import { createDomain } from '@/modules/channels/public';

export async function POST(request:Request) {

return adminMutation(request,async (body,actor)=>{let result:unknown=null;let status=200;
        result = await createDomain({
          domain: text(body, "domain"),
          accountIds: strings(body.accountIds),
        }, actor);
        status = 201;
        
return {result,status};});
}
