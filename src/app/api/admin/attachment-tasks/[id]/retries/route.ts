import { adminMutation,text } from '@/server/admin-mutation';
import { retryAttachmentScan } from '@/modules/attachments/public';
import { z } from 'zod';

export async function POST(request:Request, context:{params:Promise<{id:string}>}) {
const parameters=await context.params;
return adminMutation(request,async (body,actor)=>{let result:unknown=null;const status=200;
        result=await retryAttachmentScan(text(body,"id"),z.enum(["outbound","inbound"]).parse(body.kind),null,actor);
        
return {result,status};},parameters);
}
