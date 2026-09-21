import { removeSuppression } from "@/modules/core/resources/service";
import { authenticateService } from "@/server/auth";
import { apiProblem } from "@/server/service-api";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const identity = await authenticateService(request);
  if (!identity) return apiProblem("Unauthorized", 401, "A valid Envoy service credential is required.");
  const removed = await removeSuppression((await context.params).id, identity.productId);
  return removed ? new Response(null, { status: 204 }) : apiProblem("Not found", 404, "Suppression not found.");
}
