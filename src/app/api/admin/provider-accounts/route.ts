import { providerTypeSchema } from '@/integrations/providers/contracts';
import { adminMutation,object,text } from '@/server/admin-mutation';
import { createProviderAccount } from '@/modules/channels/public';

export async function POST(request:Request) {

return adminMutation(request,async (body,actor)=>{let result:unknown=null;let status=200; {
        const type = providerTypeSchema.parse(body.type);
        result = await createProviderAccount({
          type,
          name: text(body, "name"),
          configuration: object(body, "configuration"),
          credentials: object(body, "credentials")
        }, actor);
        status = 201;
        }
return {result,status};});
}
