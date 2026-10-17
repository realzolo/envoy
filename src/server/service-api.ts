import type { ZodError } from "zod";
import { decodeCursor, DuplicateRiskError, IdempotencyConflictError, MessageValidationError } from "@/modules/core/message/service";
import { authenticateService, type ServiceIdentity } from "@/server/auth";
import { enforceRateLimit } from "@/server/runtime-store";
import { createId } from "@/server/ids";
import { recordRequest } from "@/server/request-log";
import { BodyTooLargeError, readRequestBytes } from "@/server/request-body";
import { MAX_REQUEST_BYTES } from "@/lib/contracts";

export function apiProblem(title: string, status: number, detail = title, errors?: unknown) {
  return Response.json({ type: `https://envoy.local/problems/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, title, status, detail, ...(errors ? { errors } : {}) }, {
    status, headers: { "content-type": "application/problem+json", ...(status === 401 ? { "www-authenticate": 'Bearer realm="Envoy"' } : {}) },
  });
}

class RequestBodyError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function readJson(request: Request, optional = false, maximum = MAX_REQUEST_BYTES): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json") && (!optional || request.body)) throw new RequestBodyError(415, "Content-Type must be application/json.");
  let bytes: Uint8Array;
  try { bytes = await readRequestBytes(request, maximum); }
  catch (error) {
    if (error instanceof BodyTooLargeError) throw new RequestBodyError(413, error.message);
    throw error;
  }
  if (!bytes.byteLength) { if (optional) return {}; throw new RequestBodyError(400, "A JSON body is required."); }
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new RequestBodyError(400, "The request body must contain valid JSON."); }
}

export function serviceRoute<T = unknown>(handler: (request: Request, identity: ServiceIdentity, context: T) => Promise<Response>) {
  return async (request: Request, context?: T) => {
    const requestId = createId("req");
    const started = Date.now();
    let actor: string | null = null;
    let response: Response;
    const headers = new Headers({ "X-Request-ID": requestId, "Cache-Control": "no-store" });
    try {
      const identity = await authenticateService(request);
      if (!identity) response = apiProblem("Unauthorized", 401, "A valid Envoy service credential is required.");
      else {
        actor = `service:${identity.serviceId}`;
        const rate = await enforceRateLimit(identity.serviceId, identity.rateLimitPerMinute);
        headers.set("RateLimit-Limit", String(rate.limit));
        headers.set("RateLimit-Remaining", String(rate.remaining));
        const seconds = Math.max(1, Math.ceil((rate.resetAt.getTime() - Date.now()) / 1000));
        headers.set("RateLimit-Reset", String(seconds));
        if (!rate.allowed) { headers.set("Retry-After", String(seconds)); response = apiProblem("Rate limit exceeded", 429, "Service request quota exceeded."); }
        else response = await handler(request, identity, context as T);
      }
    } catch (error) {
      if (error instanceof RequestBodyError) response = apiProblem(error.status === 413 ? "Payload too large" : error.status === 415 ? "Unsupported media type" : "Invalid JSON", error.status, error.message);
      else if (error instanceof DuplicateRiskError || error instanceof IdempotencyConflictError) response = apiProblem("Conflict", 409, error.message);
      else if (error instanceof MessageValidationError) response = apiProblem("Validation failed", 422, error.issues.join(" "));
      else { console.error("Service API failed", { requestId, error }); response = apiProblem("Service unavailable", 503, "The request could not be completed. Retry with the same idempotency key when applicable."); }
    }
    if (response.status >= 400) {
      const content = await response.json().catch(() => ({}));
      response = Response.json({ type: "about:blank", title: "Request failed", status: response.status, detail: content.title ?? "Request failed", ...content, requestId }, { status: response.status, headers: response.headers });
    }
    headers.forEach((value, key) => response.headers.set(key, value));
    await recordRequest({ requestId, method: request.method, path: new URL(request.url).pathname, statusCode: response.status, durationMs: Date.now() - started, actor });
    return response;
  };
}

export function pagination(request: Request) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const rawCursor = url.searchParams.get("cursor");
  const cursor = decodeCursor(rawCursor);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (rawCursor && !cursor)) return null;
  return { url, limit, cursor };
}

export function validationErrors(error: ZodError) {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) { const path = issue.path.join(".") || "body"; (fields[path] ??= []).push(issue.message); }
  return fields;
}
