import { AttachmentUseError } from "@/modules/attachments/safety";
import { getAdminSession } from "@/server/admin-auth";
import { getInboundAttachment } from "@/modules/core/resources/service";

export async function GET(_request: Request, context: { params: Promise<{id:string;attachmentId:string}> }) {
  if (!await getAdminSession()) return Response.json({error:"Unauthorized"},{status:401});
  const {id,attachmentId} = await context.params;
  try {return await getInboundAttachment(id,attachmentId) ?? Response.json({error:"Attachment unavailable"},{status:404});}
  catch(error) {if(error instanceof AttachmentUseError) return Response.json({code:error.code,reasonCode:error.reasonCode},{status:409});throw error;}
}
