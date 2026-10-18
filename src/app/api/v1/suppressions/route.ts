import { createSuppressionSchema } from "@/lib/contracts";
import { createSuppression, listSuppressions } from "@/modules/core/resources/service";
import { validationErrors, serviceRoute, readJson, apiProblem } from "@/server/service-api";

export const GET = serviceRoute(async (request, identity) => {
  if(!identity.suppressionManagement) return apiProblem("Forbidden",403,"Suppression management requires an independent service permission.");
  return Response.json({ data: await listSuppressions(identity.productId, new URL(request.url).searchParams.get("email")) });
});

export const POST = serviceRoute(async (request, identity) => {
  if(!identity.suppressionManagement) return apiProblem("Forbidden",403,"Suppression management requires an independent service permission.");
  const parsed = createSuppressionSchema.safeParse(await readJson(request, true));
  if (!parsed.success) return apiProblem("Validation failed", 422, "The suppression request is invalid.", validationErrors(parsed.error));
  const result = await createSuppression({ productId: identity.productId, ...parsed.data });
  return Response.json(result, {
    status: result.duplicate ? 200 : 201,
    headers: { Location: `/api/v1/suppressions/${result.id}` },
  });
});
