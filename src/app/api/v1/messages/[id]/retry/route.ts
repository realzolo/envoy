import { validationErrors, serviceRoute, readJson, apiProblem, getRequestId } from "@/server/service-api";
import { retryMessageSchema } from "@/lib/contracts";
import { retryMessage } from "@/modules/outbound/public";

export const POST = serviceRoute(async (request, identity, context: { params: Promise<{ id: string }> }) => {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || key.length > 256) return apiProblem("Invalid idempotency key", 400, "Idempotency-Key is required and must be at most 256 characters.");
  const parsed = retryMessageSchema.safeParse(await readJson(request, true));
  if (!parsed.success) return apiProblem("Validation failed", 422, "The retry does not match the API contract.", validationErrors(parsed.error));
  const result = await retryMessage((await context.params).id, identity.serviceId, parsed.data, key, `service:${identity.serviceId}:${getRequestId(request)}`);
  return result ? Response.json(result, { status: 202 }) : apiProblem("Not found", 404);
});
