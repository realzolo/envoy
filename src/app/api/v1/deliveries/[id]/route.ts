import { getDelivery } from "@/modules/core/resources/service";
import { authenticateService } from "@/server/auth";
import { apiProblem } from "@/server/service-api";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const identity = await authenticateService(request);
  if (!identity) return apiProblem("Unauthorized", 401, "A valid Envoy service credential is required.");
  const delivery = await getDelivery((await context.params).id, identity.serviceId);
  return delivery ? Response.json(delivery) : apiProblem("Not found", 404, "Delivery not found.");
}
