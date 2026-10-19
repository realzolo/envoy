import { adminMutation } from '@/server/admin-mutation';
import { replaceCallbackSecret } from '@/modules/callbacks/public';

export async function PUT(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{
        if ("secret" in body) throw new Error("Callback secret cannot be supplied");
        const result = await replaceCallbackSecret(parameters.id, actor);
        return {result,status:200};
    },parameters);
}
