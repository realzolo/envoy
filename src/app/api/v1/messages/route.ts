import { createMessageSchema, type ProblemDetails } from "@/lib/contracts";
import { authenticateService } from "@/server/auth";
import { enforceRateLimit } from "@/server/redis";
import { acceptMessage, IdempotencyConflictError, MessageValidationError } from "@/modules/core/message/service";
import { recordRequest } from "@/server/request-log";

export const runtime = "nodejs";

function problem(body: ProblemDetails) {
  return Response.json(body, {
    status: body.status,
    headers: { "content-type": "application/problem+json" },
  });
}

export async function POST(request: Request) {
  const started = Date.now();
  const identity = await authenticateService(request);

  if (!identity) {
    const response = problem({
      type: "https://envoy.local/problems/unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "A valid Envoy service credential is required.",
    });
    await recordRequest({
      method: "POST",
      path: "/api/v1/messages",
      statusCode: 401,
      durationMs: Date.now() - started
    });
    return response;
  }

  const rateLimit = await enforceRateLimit(identity.serviceId, identity.rateLimitPerMinute);
  if (!rateLimit.allowed) {
    return Response.json(
      {
        type: "https://envoy.local/problems/rate-limit",
        title: "Rate limit exceeded",
        status: 429,
        detail: "Service request quota exceeded."
      },
      {
        status: 429,
        headers: { "Retry-After": "60", "RateLimit-Limit": String(rateLimit.limit), "RateLimit-Remaining": "0" }
      },
    );
  }

  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 256) {
    return problem({
      type: "https://envoy.local/problems/invalid-idempotency-key",
      title: "Invalid idempotency key",
      status: 400,
      detail: "Idempotency-Key is required and must be at most 256 characters.",
    });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return problem({
      type: "https://envoy.local/problems/invalid-json",
      title: "Invalid JSON",
      status: 400,
      detail: "The request body must contain valid JSON.",
    });
  }

  const parsed = createMessageSchema.safeParse(json);
  if (!parsed.success) {
    return problem({
      type: "https://envoy.local/problems/validation-error",
      title: "Validation failed",
      status: 422,
      detail: "The message request does not match the Envoy API contract.",
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  let accepted;
  try {
    accepted = await acceptMessage({ identity, idempotencyKey, input: parsed.data });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return problem({
        type: "https://envoy.local/problems/idempotency-conflict",
        title: "Idempotency conflict",
        status: 409,
        detail: "This idempotency key has already been used with a different payload.",
      });
    }
    if (error instanceof MessageValidationError) {
      return problem({
        type: "https://envoy.local/problems/message-validation",
        title: "Message cannot be queued",
        status: 422,
        detail: error.issues.join(" "),
      });
    }
    throw error;
  }

  const response = Response.json(accepted.message, {
    status: 202,
    headers: {
      Location: `/api/v1/messages/${accepted.message.id}`,
      "X-Envoy-Idempotent-Replay": String(accepted.duplicate),
      "RateLimit-Limit": String(rateLimit.limit),
      "RateLimit-Remaining": String(rateLimit.remaining),
    },
  });
  await recordRequest({
    method: "POST",
    path: "/api/v1/messages",
    statusCode: 202,
    durationMs: Date.now() - started,
    actor: `service:${identity.serviceId}`,
    details: { messageId: accepted.message.id, duplicate: accepted.duplicate }
  });
  return response;
}
