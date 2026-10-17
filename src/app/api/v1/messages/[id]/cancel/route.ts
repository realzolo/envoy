import { serviceRoute, apiProblem } from "@/server/service-api";
import { cancelMessage } from "@/modules/core/message/service";

export const POST = serviceRoute(async (request, identity, context: { params: Promise<{ id: string }> }) => {
  const result = await cancelMessage((await context.params).id, identity.serviceId);
  if (!result) {
    return apiProblem("Not found", 404);
  }
  return Response.json(result, { status: 202 });
});
