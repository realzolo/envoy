import { adminMutation,object,text } from '@/server/admin-mutation';
import { toggleService,updateService } from '@/modules/identity/public';
import { z } from 'zod';

export async function PUT(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{let result:unknown=null;const status=200;
        result = await updateService(text(body, "id"), object(body, "configuration"), z.number().int().positive().parse(body.revision), actor);
        
return {result,status};},parameters);
}

export async function PATCH(request:Request, context:{params:Promise<{id:string}>}) {
  return adminMutation(request, async (body,actor) => {
    await toggleService(text(body,"id"), z.boolean().parse(body.enabled), actor);
    return {result:null,status:200};
  }, await context.params);
}
