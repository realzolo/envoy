import { listDeliveries } from "@/modules/core/resources/service";
import { serviceRoute, apiProblem, pagination } from "@/server/service-api";

import { deliveryStatuses } from "@/lib/contracts";

export const GET = serviceRoute(async (request, identity) => {
  const page = pagination(request);
  if (!page) return apiProblem("Invalid query", 400, "limit or cursor is invalid.");
  const status = page.url.searchParams.get("status");
  if (status && !deliveryStatuses.some(value => value === status)) return apiProblem("Invalid query", 400, "status is not supported.");
  return Response.json(await listDeliveries(identity.serviceId, {
    limit: page.limit,
    cursor: page.cursor,
    messageId: page.url.searchParams.get("messageId"),
    status,
  }));
});
