import { listSenderProfiles } from "@/modules/core/resources/service";
import { authenticateService } from "@/server/auth";
import { apiProblem } from "@/server/service-api";

export async function GET(request: Request) {
  const identity = await authenticateService(request);
  if (!identity) return apiProblem("Unauthorized", 401, "A valid Envoy service credential is required.");
  return Response.json({ data: await listSenderProfiles(identity.productId) });
}
