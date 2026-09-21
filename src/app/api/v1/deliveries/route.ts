import { listDeliveries } from "@/modules/core/resources/service";
import { authenticateService } from "@/server/auth";
import { apiProblem, pagination } from "@/server/service-api";

const statuses = ["queued", "submitting", "accepted", "deferred", "delivered", "bounced", "failed", "unknown", "canceled"];

export async function GET(request: Request) {
  const identity = await authenticateService(request);
  if (!identity) return apiProblem("Unauthorized", 401, "A valid Envoy service credential is required.");
  const page = pagination(request);
  if (!page) return apiProblem("Invalid query", 400, "limit or cursor is invalid.");
  const status = page.url.searchParams.get("status");
  if (status && !statuses.includes(status)) return apiProblem("Invalid query", 400, "status is not supported.");
  return Response.json(await listDeliveries(identity.serviceId, {
    limit: page.limit,
    cursor: page.cursor,
    messageId: page.url.searchParams.get("messageId"),
    status,
  }));
}
