import { adminMutation,text } from '@/server/admin-mutation';
import { setDomainInboundProvider,toggleDomain } from '@/modules/channels/public';

export async function PUT(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{
  await setDomainInboundProvider(parameters.id,typeof body.inboundProviderAccountId==='string'?body.inboundProviderAccountId:null,actor);
  return {result:null,status:200};
},parameters);
}

export async function PATCH(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{const result:unknown=null;const status=200;
        await toggleDomain(text(body, "id"), body.enabled === true, actor);
        
return {result,status};},parameters);
}
