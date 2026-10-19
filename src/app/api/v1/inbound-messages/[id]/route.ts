import { getInboundMessage } from "@/modules/inbound/public";
import { serviceRoute, apiProblem } from "@/server/service-api";

export const GET = serviceRoute(async (request, identity, context: { params: Promise<{ id: string }> }) => {
  const message = await getInboundMessage((await context.params).id, identity.serviceId);
  return message ? Response.json(message) : apiProblem("Not found", 404, "Inbound message not found.");
});
