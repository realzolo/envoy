import { listInboundMessages } from "@/modules/core/resources/service";
import { serviceRoute, apiProblem, pagination } from "@/server/service-api";

export const GET = serviceRoute(async (request, identity) => {
  const page = pagination(request);
  if (!page) return apiProblem("Invalid query", 400, "limit or cursor is invalid.");
  return Response.json(await listInboundMessages(identity.serviceId, { limit: page.limit, cursor: page.cursor }));
});
