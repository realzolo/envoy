import { getRequestDiagnostic } from "@/modules/core/resources/service";
import { apiProblem, serviceRoute } from "@/server/service-api";
export const GET = serviceRoute(async (_request, identity, context: { params: Promise<{ requestId: string }> }) => {
  const result = await getRequestDiagnostic((await context.params).requestId, identity.serviceId);
  return result ? Response.json(result) : apiProblem("Not found", 404);
});
