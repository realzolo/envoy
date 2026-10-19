import { downloadAttachment } from "@/modules/attachments/public";
import { apiProblem, serviceRoute } from "@/server/service-api";
export const GET = serviceRoute(async (_request,identity,context:{params:Promise<{id:string}>}) => {
  return await downloadAttachment("outbound",(await context.params).id,identity.serviceId) ?? apiProblem("Not found",404);
});
