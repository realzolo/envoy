import { adminMutation,text } from '@/server/admin-mutation';
import { removeSuppressionForAdmin } from '@/modules/suppressions/public';

export async function DELETE(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{const result:unknown=null;const status=200;
        await removeSuppressionForAdmin(text(body, "id"), actor);
        
return {result,status};},parameters);
}
