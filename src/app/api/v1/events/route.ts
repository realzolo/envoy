import { eventTypes } from "@/lib/contracts";
import { listEvents } from "@/modules/core/resources/service";
import { serviceRoute, apiProblem, pagination } from "@/server/service-api";

export const GET = serviceRoute(async (request, identity) => {
  const page = pagination(request);
  if (!page) return apiProblem("Invalid query", 400, "limit or cursor is invalid.");
  const type = page.url.searchParams.get("type");
  if (type && !eventTypes.some(value => value === type)) return apiProblem("Invalid query", 400, "type is not supported.");
  return Response.json(await listEvents(identity.serviceId, {
    limit: page.limit,
    cursor: page.cursor,
    deliveryId: page.url.searchParams.get("deliveryId"),
    messageId: page.url.searchParams.get("messageId"),
    type,
  }));
});
