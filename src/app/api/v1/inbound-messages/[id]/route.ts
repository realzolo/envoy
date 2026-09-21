import { getInboundMessage } from "@/modules/core/resources/service";
import { authenticateService } from "@/server/auth";
import { apiProblem } from "@/server/service-api";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const identity = await authenticateService(request);
  if (!identity) return apiProblem("Unauthorized", 401, "A valid Envoy service credential is required.");
  const message = await getInboundMessage((await context.params).id, identity.serviceId);
  return message ? Response.json(message) : apiProblem("Not found", 404, "Inbound message not found.");
}
