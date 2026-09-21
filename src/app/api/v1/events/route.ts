import { listEvents } from "@/modules/core/resources/service";
import { authenticateService } from "@/server/auth";
import { apiProblem, pagination } from "@/server/service-api";

export async function GET(request: Request) {
  const identity = await authenticateService(request);
  if (!identity) return apiProblem("Unauthorized", 401, "A valid Envoy service credential is required.");
  const page = pagination(request);
  if (!page) return apiProblem("Invalid query", 400, "limit or cursor is invalid.");
  return Response.json(await listEvents(identity.serviceId, {
    limit: page.limit,
    cursor: page.cursor,
    deliveryId: page.url.searchParams.get("deliveryId"),
    type: page.url.searchParams.get("type"),
  }));
}
