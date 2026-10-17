import { validationErrors, serviceRoute, readJson, apiProblem } from "@/server/service-api";
import { retryMessageSchema } from "@/lib/contracts";
import { DuplicateRiskError, retryMessage } from "@/modules/core/message/service";

export const POST = serviceRoute(async (request, identity, context: { params: Promise<{ id: string }> }) => {
  const parsed = retryMessageSchema.safeParse(await readJson(request, true));
  if (!parsed.success) {
    return Response.json({
      title: "Validation failed",
      status: 422,
      errors: validationErrors(parsed.error),
    }, { status: 422, headers: { "content-type": "application/problem+json" } });
  }
  try {
    const result = await retryMessage(
      (await context.params).id,
      identity.serviceId,
      parsed.data.acknowledgeDuplicateRisk,
    );
    if (!result) {
      return apiProblem("Not found", 404);
    }
    return Response.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof DuplicateRiskError) {
      return Response.json({ title: "Duplicate-risk acknowledgement required", status: 409, detail: error.message }, {
        status: 409,
        headers: { "content-type": "application/problem+json" },
      });
    }
    throw error;
  }
});
