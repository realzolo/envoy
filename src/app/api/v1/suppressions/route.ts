import { createSuppressionSchema } from "@/lib/contracts";
import { createSuppression, listSuppressions } from "@/modules/core/resources/service";
import { authenticateService } from "@/server/auth";
import { apiProblem } from "@/server/service-api";

export async function GET(request: Request) {
  const identity = await authenticateService(request);
  if (!identity) return apiProblem("Unauthorized", 401, "A valid Envoy service credential is required.");
  return Response.json({ data: await listSuppressions(identity.productId, new URL(request.url).searchParams.get("email")) });
}

export async function POST(request: Request) {
  const identity = await authenticateService(request);
  if (!identity) return apiProblem("Unauthorized", 401, "A valid Envoy service credential is required.");
  const parsed = createSuppressionSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return apiProblem("Validation failed", 422, "The suppression request is invalid.", parsed.error.flatten().fieldErrors);
  const result = await createSuppression({ productId: identity.productId, ...parsed.data });
  return Response.json(result, {
    status: result.duplicate ? 200 : 201,
    headers: { Location: `/api/v1/suppressions/${result.id}` },
  });
}
