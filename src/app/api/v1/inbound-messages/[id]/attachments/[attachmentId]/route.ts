import { getInboundAttachment } from "@/modules/inbound/public";
import { serviceRoute, apiProblem } from "@/server/service-api";

export const GET = serviceRoute(async (_request, identity, context: { params: Promise<{ id: string; attachmentId: string }> }) => {
  const { id, attachmentId } = await context.params;
  return await getInboundAttachment(id, attachmentId, identity.serviceId) ?? apiProblem("Not found", 404, "Attachment is unavailable.");
});
