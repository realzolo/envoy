import { createMessageSchema, processingStates, messageOutcomes } from "@/lib/contracts";
import { acceptMessage, listMessages } from "@/modules/core/message/service";
import { validationErrors, apiProblem, pagination, readJson, serviceRoute, getRequestId } from "@/server/service-api";

export const runtime = "nodejs";

export const GET = serviceRoute(async (request, identity) => {
  const page = pagination(request);
  if (!page) return apiProblem("Invalid query", 400, "limit must be between 1 and 100 and cursor must be valid.");
  if ([...page.url.searchParams.keys()].some(key => !["limit", "cursor", "processingState", "outcome", "referenceId"].includes(key))) return apiProblem("Invalid query", 400, "Unsupported message query parameter.");
  const processingState = page.url.searchParams.get("processingState");
  const outcome = page.url.searchParams.get("outcome");
  if (processingState && !processingStates.includes(processingState as typeof processingStates[number])) return apiProblem("Invalid query", 400, "processingState is not supported.");
  if (outcome && !messageOutcomes.includes(outcome as typeof messageOutcomes[number])) return apiProblem("Invalid query", 400, "outcome is not supported.");
  return Response.json(await listMessages(identity.serviceId, { limit: page.limit, cursor: page.cursor, processingState, outcome, referenceId: page.url.searchParams.get("referenceId") }));
});

export const POST = serviceRoute(async (request, identity) => {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 256) return apiProblem("Invalid idempotency key", 400, "Idempotency-Key is required and must be at most 256 characters.");
  const parsed = createMessageSchema.safeParse(await readJson(request));
  if (!parsed.success) return apiProblem("Validation failed", 422, "The message does not match the API contract.", validationErrors(parsed.error));
  const accepted = await acceptMessage({ identity, idempotencyKey, input: parsed.data, requestId: getRequestId(request) });
  return Response.json(accepted.message, { status: 202, headers: { Location: `/api/v1/messages/${accepted.message.id}`, "X-Envoy-Idempotent-Replay": String(accepted.duplicate) } });
});
