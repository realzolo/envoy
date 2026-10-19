import { retryAttachmentScan } from "@/modules/attachments/public";
import { apiProblem, serviceRoute } from "@/server/service-api";
export const POST = serviceRoute(async (_request,identity,context:{params:Promise<{id:string}>}) => {
  const result=await retryAttachmentScan((await context.params).id,"outbound",identity.serviceId,`service:${identity.serviceId}`);
  return result ? Response.json(result,{status:202}) : apiProblem("Not found",404);
});
