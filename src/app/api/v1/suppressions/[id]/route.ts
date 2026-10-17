import { removeSuppression } from "@/modules/core/resources/service";
import { serviceRoute, apiProblem } from "@/server/service-api";

export const DELETE = serviceRoute(async (request, identity, context: { params: Promise<{ id: string }> }) => {
  const removed = await removeSuppression((await context.params).id, identity.productId);
  return removed ? new Response(null, { status: 204 }) : apiProblem("Not found", 404, "Suppression not found.");
});
