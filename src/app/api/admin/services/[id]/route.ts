import { adminMutation,object,text } from '@/server/admin-mutation';
import { updateService } from '@/modules/identity/public';
import { z } from 'zod';

export async function PUT(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{let result:unknown=null;const status=200;
        result = await updateService(text(body, "id"), object(body, "configuration"), z.number().int().positive().parse(body.revision), actor);
        
return {result,status};},parameters);
}
