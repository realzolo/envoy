import { retryAttachmentScan } from "@/modules/attachments/public";
import { ownsInboundAttachment } from "@/modules/inbound/public";
import { apiProblem, serviceRoute } from "@/server/service-api";
export const POST = serviceRoute(async (_request,identity,context:{params:Promise<{id:string;attachmentId:string}>}) => {
  const {id,attachmentId}=await context.params;
  if(!await ownsInboundAttachment(id,attachmentId,identity.serviceId)) return apiProblem("Not found",404);
  const result=await retryAttachmentScan(attachmentId,"inbound",identity.serviceId,`service:${identity.serviceId}`);
  return result ? Response.json(result,{status:202}) : apiProblem("Not found",404);
});
