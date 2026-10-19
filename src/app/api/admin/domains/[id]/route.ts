import { adminMutation,text } from '@/server/admin-mutation';
import { setDomainInboundProvider,toggleDomain } from '@/modules/channels/public';
import { z } from 'zod';

export async function PUT(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{
  const providerAccountId = z.union([z.string().trim().min(1), z.null()]).parse(body.inboundProviderAccountId);
  await setDomainInboundProvider(parameters.id,providerAccountId,actor);
  return {result:null,status:200};
},parameters);
}

export async function PATCH(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{const result:unknown=null;const status=200;
        await toggleDomain(text(body, "id"), body.enabled === true, actor);
        
return {result,status};},parameters);
}
