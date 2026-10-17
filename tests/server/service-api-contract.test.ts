import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageSchema, inboundDetailSchema, messageDetailSchema } from "@/lib/contracts";
import { apiProblem, readJson, serviceRoute } from "@/server/service-api";
import { authenticateService } from "@/server/auth";
import { enforceRateLimit } from "@/server/runtime-store";
import { query } from "@/server/database";
import { recordRequest } from "@/server/request-log";
import { getDelivery, getInboundAttachment, getInboundMessage, getRequestDiagnostic } from "@/modules/core/resources/service";
import { GET as openapi } from "@/app/api/v1/openapi.json/route";
import { GET as getMessage } from "@/app/api/v1/messages/[id]/route";
vi.mock("@/server/auth", () => ({ authenticateService: vi.fn() }));
vi.mock("@/server/runtime-store", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("@/server/database", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("@/modules/config/object-store", () => ({ objectStore: () => ({ get: vi.fn().mockResolvedValue(Buffer.from("safe-attachment")) }) }));
const identity = { serviceId: "svc", serviceName: "Test", productId: "prd", product: "Test", rateLimitPerMinute: 600 };
beforeEach(() => {
  vi.mocked(authenticateService).mockResolvedValue(identity);
  vi.mocked(enforceRateLimit).mockResolvedValue({ allowed: true, limit: 600, remaining: 599, resetAt: new Date(Date.now() + 60000) });
  vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] });
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
describe("public API boundary", () => {
  it("authenticates and limits reads and returns consistent problem and request headers", async () => {
    vi.mocked(enforceRateLimit).mockResolvedValue({ allowed: false, limit: 600, remaining: 0, resetAt: new Date(Date.now() + 60000) });
    const handler = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const response = await serviceRoute(handler)(new Request("https://envoy.test/api/v1/events"));
    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await response.json()).toMatchObject({ status: 429, type: expect.any(String), title: expect.any(String), detail: expect.any(String), requestId: response.headers.get("x-request-id") });
  });
  it("returns a Bearer challenge on authentication failure", async () => {
    vi.mocked(authenticateService).mockResolvedValue(null);
    const response = await serviceRoute(async () => Response.json({}))(new Request("https://envoy.test/api/v1/messages"));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });
  it("logs authenticated pre-acceptance failures with request correlation and an actionable problem", async () => {
    const response = await serviceRoute(async () => apiProblem("Sender not authorized", 422, "No sender grant matches the requested address.", undefined, "SENDER_NOT_AUTHORIZED"))(new Request("https://envoy.test/api/v1/messages", { method: "POST" }));
    const problem = await response.json();
    const call = vi.mocked(query).mock.calls.find(([sql]) => sql.includes("INSERT INTO request_logs"));
    expect(call?.[1]).toEqual(expect.arrayContaining([identity.serviceId]));
    expect(call?.[1]?.[0]).toBe(problem.requestId);
    expect(call?.[1]?.[6]).toMatchObject({ problem: { code: "SENDER_NOT_AUTHORIZED", detail: "No sender grant matches the requested address." } });
    expect(problem.requestId).toBe(response.headers.get("x-request-id"));
  });
  it("scopes request diagnostics to the authenticated service", async () => {
    expect(await getRequestDiagnostic("req_private", "svc_other")).toBeNull();
    expect(vi.mocked(query).mock.calls[0]).toEqual([expect.stringContaining("request_id=$1 AND service_id=$2"), ["req_private", "svc_other"]]);
  });
  it("stops oversized chunked bodies while consuming the stream", async () => {
    let canceled = false;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(11)); }, cancel() { canceled = true; } });
    const request = new Request("https://envoy.test", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    await expect(readJson(request, false, 10)).rejects.toMatchObject({ status: 413 });
    expect(canceled).toBe(true);
  });
  it("requires an exact JSON media type and rejects invalid UTF-8 rather than corrupting content", async () => {
    await expect(readJson(new Request("https://envoy.test", { method: "POST", headers: { "content-type": "application/jsonp" }, body: "{}" }))).rejects.toMatchObject({ status: 415 });
    await expect(readJson(new Request("https://envoy.test", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: new Uint8Array([123,34,120,34,58,34,255,34,125]) }))).rejects.toMatchObject({ status: 400 });
  });
  it("validates UTF-8 content bytes and metadata cardinality", () => {
    const input = { from: { email: "sender@example.net" }, to: [{ email: "a@example.net" }], subject: "x", text: "汉".repeat(700000) };
    expect(createMessageSchema.safeParse(input).success).toBe(false);
    expect(createMessageSchema.safeParse({ ...input, text: "Hello", metadata: Object.fromEntries(Array.from({ length: 21 }, (_, n) => [`k${n}`, "v"])) }).success).toBe(false);
  });
  it("does not turn an accepted write into a failure when ordinary logging fails", async () => {
    vi.mocked(query).mockRejectedValue(new Error("log storage unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordRequest({ method: "POST", path: "/api/v1/messages", statusCode: 202, durationMs: 1 })).resolves.toBeUndefined();
    const response = await serviceRoute(async () => Response.json({ id: "msg" }, { status: 202 }))(new Request("https://envoy.test/api/v1/messages", { method: "POST" }));
    expect(response.status).toBe(202);
    error.mockRestore();
  });
  it("exposes actionable diagnostic fields without native identifiers or unrestricted metadata", async () => {
    const at = new Date("2026-10-17T00:00:00Z");
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ id: "d", message_id: "m", queued_at: at, updated_at: at }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: "a", attempt_number: 1, provider: "resend", provider_account: "private", external_message_id: "native-secret", diagnostic: { code: "PROVIDER_REJECTED", message: "Recipient rejected", stage: "submission", acceptance: "not_accepted", retryable: false, retryDecision: { action: "none" }, private: "secret" }, started_at: at }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: "e", event_type: "delivered", occurred_at: at, canonical_payload: { externalMessageId: "native-secret", metadata: { private: "secret" }, recipient: "a@example.net" } }], rowCount: 1 } as never);
    const result = JSON.stringify(await getDelivery("d", "svc"));
    expect(result).not.toContain("native-secret");
    expect(result).not.toContain("private");
    expect(result).toContain("PROVIDER_REJECTED");
    expect(result).toContain("Recipient rejected");
    expect(result).toContain("a@example.net");
  });
  it("requires ready state, scan policy and service ownership before reading an attachment", async () => {
    vi.stubEnv("CLAMAV_HOST", "clamav");
    expect(await getInboundAttachment("inb", "att", "other-service")).toBeNull();
    const [sql, parameters] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain("i.status='ready'");
    expect(sql).toContain("i.service_id=$3");
    expect(parameters).toEqual(["inb", "att", "other-service", false]);
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ file_name: '汉字\r\n".html', content_type: "text/html", object_key: "private/path" }], rowCount: 1 } as never);
    const response = await getInboundAttachment("inb", "att", "svc");
    expect(response?.headers.get("content-type")).toBe("application/octet-stream");
    expect(response?.headers.get("content-disposition")).toContain("attachment;");
    expect(response?.headers.get("content-disposition")).not.toMatch(/[\r\n]/);
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it.each([null, new Date("2026-10-17T08:00:00+08:00")])("distinguishes retained and purged content with UTC markers (%s)", async contentPurgedAt => {
    const at = new Date("2026-10-16T00:00:00Z");
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ id: "msg", processing_state: "finished", outcome: "succeeded", counts: Object.fromEntries(["queued", "submitting", "accepted", "deferred", "delivered", "bounced", "failed", "unknown", "canceled", "suppressed"].map(key => [key,key === "delivered" ? 1 : 0])), request_id: "req", sender_snapshot: { fromEmail: "sender@example.net", fromName: "Sender" }, to_recipients: [{ email: "customer@example.net" }], cc_recipients: [], bcc_recipients: [], headers: {}, in_reply_to: null, references_ids: [], attachment_snapshot: [], product: "Test", category: "transactional", subject: contentPurgedAt ? "" : "Hello", html_body: null, text_body: contentPurgedAt ? null : "Hello", reply_to: [], metadata: {}, provider_tags: {}, recipient_count: 1, accepted_at: at, reference_id: null, content_purged_at: contentPurgedAt }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    const response = await getMessage(new Request("https://envoy.test/api/v1/messages/msg"), { params: Promise.resolve({ id: "msg" }) });
    const message = messageDetailSchema.parse(await response.json());
    expect(message.contentPurgedAt).toBe(contentPurgedAt ? "2026-10-17T00:00:00.000Z" : null);

    vi.mocked(query).mockResolvedValueOnce({ rows: [{ id: "inb", from_email: "a@example.net", to_emails: ["b@example.net"], cc_emails: [], bcc_emails: [], subject: contentPurgedAt ? "" : "Hello", sanitized_html: null, text_body: contentPurgedAt ? null : "Hello", status: "ready", rejection_reason: null, received_at: at, content_purged_at: contentPurgedAt }] } as never)
      .mockResolvedValueOnce({ rows: [null, at].map((purgedAt, index) => ({ id: `att${index}`, file_name: "receipt.txt", content_type: "text/plain", size_bytes: "12", content_id: null, scan_status: "clean", content_purged_at: purgedAt, object_key: "private/object-key" })) } as never);
    const inboundResult = await getInboundMessage("inb", "svc");
    const inbound = inboundDetailSchema.parse(inboundResult);
    expect(inbound.contentPurgedAt).toBe(message.contentPurgedAt);
    expect(inbound.attachments.map(item => item.contentAvailable)).toEqual([true, false]);
    expect(JSON.stringify(inboundResult)).not.toContain("private/object-key");
  });
  it("publishes response schemas, filters, errors and attachment authorization in OpenAPI", async () => {
    const document = await openapi(new Request("https://envoy.test/api/v1/openapi.json")).json();
    expect(document.components.schemas.Problem.required).toContain("requestId");
    expect(document.components.schemas.CreateMessage.properties.metadata.propertyNames.pattern).toContain("64");
    expect(document.paths["/messages"].get.responses["200"].content["application/json"].schema.properties.nextCursor).toBeDefined();
    expect(document.paths["/events"].get.parameters.find((item: { name: string }) => item.name === "type").schema.enum).toContain("unknown");
    expect(document.paths["/inbound-messages/{id}/attachments/{attachmentId}"].get.responses["404"]).toBeDefined();
    expect(document.components.schemas.MessageDetail.required).toContain("contentPurgedAt");
    expect(document.components.schemas.InboundDetail.required).toContain("contentPurgedAt");
    expect(document.components.schemas.InboundDetail.properties.attachments.items.properties.contentAvailable.type).toBe("boolean");
  });
});
