import { getOutboundFile } from "@/modules/files/service";
import { apiProblem, serviceRoute } from "@/server/service-api";
export const GET = serviceRoute(async (_request, identity, context: { params: Promise<{ id: string }> }) => {
  const file = await getOutboundFile((await context.params).id, identity.serviceId);
  return file ? Response.json(file) : apiProblem("Not found", 404);
});
