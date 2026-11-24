import { getDelivery } from "@/modules/outbound/public";
import { apiProblem, serviceRoute } from "@/server/service-api";

export const GET = serviceRoute(async (request, identity, context: { params: Promise<{ id: string }> }) => {
  const delivery = await getDelivery((await context.params).id, identity.serviceId);
  return delivery ? Response.json(delivery) : apiProblem("Not found", 404, "Delivery not found.");
});
