import { getMessageAttempts } from "@/modules/outbound/public";
import { apiProblem, pagination, serviceRoute } from "@/server/service-api";
export const GET = serviceRoute(async (request, identity, context: { params: Promise<{ id: string }> }) => {
  const page = pagination(request);
  if (!page) return apiProblem("Invalid query", 400, "limit must be between 1 and 100 and cursor must be valid.");
  const result = await getMessageAttempts((await context.params).id, identity.serviceId, page);
  return result ? Response.json(result) : apiProblem("Not found", 404);
});
