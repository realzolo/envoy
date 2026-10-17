import { z } from "zod";
import { createMessageSchema, createSuppressionSchema, retryMessageSchema, deliveryStatuses, eventTypes, acceptedMessageSchema, messageSummarySchema, messageDetailSchema, deliverySummarySchema, deliveryDetailSchema, publicEventSchema, inboundSummarySchema, inboundDetailSchema, suppressionSchema, senderSchema, problemDetailsSchema } from "@/lib/contracts";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ "application/json": { schema } });
const page = (name: string) => ({ type: "object", required: ["data", "nextCursor"], properties: { data: { type: "array", items: ref(name) }, nextCursor: { type: ["string", "null"] } } });
const query = (name: string, schema: object) => ({ name, in: "query", schema });
const pageParameters = [query("limit", { type: "integer", minimum: 1, maximum: 100, default: 50 }), query("cursor", { type: "string", description: "Opaque cursor from nextCursor; retain the same filters." })];
const id = { name: "id", in: "path", required: true, schema: { type: "string" } };
const headers = { "X-Request-ID": { schema: { type: "string" } }, "RateLimit-Limit": { schema: { type: "integer" } }, "RateLimit-Remaining": { schema: { type: "integer" } }, "RateLimit-Reset": { description: "Seconds until the current fixed window resets", schema: { type: "integer" } } };
const error = (description: string) => ({ description, content: { "application/problem+json": { schema: ref("Problem") } }, headers });
const errors = { "400": error("Invalid syntax, cursor or filter"), "401": { ...error("Missing or invalid bearer credential"), headers: { ...headers, "WWW-Authenticate": { schema: { type: "string" } } } }, "404": error("Resource unavailable or not owned by this service"), "409": error("Idempotency conflict or duplicate risk requires acknowledgement"), "413": error("Request byte limit exceeded"), "415": error("JSON content type required"), "422": error("Contract or business validation failed"), "429": { ...error("Service request limit exceeded"), headers: { ...headers, "Retry-After": { schema: { type: "integer" } } } }, "503": error("Dependency temporarily unavailable; retry writes using the same idempotency key") };
function operation(summary: string, schema: object, parameters: object[] = [], status = "200") { return { summary, parameters, responses: { [status]: { description: "Success", headers, content: json(schema) }, ...errors } }; }
const body = (name: string, required = true) => ({ requestBody: { required, content: json(ref(name)) } });

export function GET(request: Request) {
  const schemas = Object.fromEntries(Object.entries({ CreateMessage: createMessageSchema, RetryMessage: retryMessageSchema, CreateSuppression: createSuppressionSchema, AcceptedMessage: acceptedMessageSchema, Message: messageSummarySchema, MessageDetail: messageDetailSchema, Delivery: deliverySummarySchema, DeliveryDetail: deliveryDetailSchema, Event: publicEventSchema, Inbound: inboundSummarySchema, InboundDetail: inboundDetailSchema, Suppression: suppressionSchema, Sender: senderSchema, Problem: problemDetailsSchema }).map(([name, schema]) => [name, z.toJSONSchema(schema, { unrepresentable: "any" })]));
  // Cross-field and UTF-8 byte constraints cannot be inferred from Zod refinements.
  const create = schemas.CreateMessage;
  create.anyOf = [{ required: ["html"] }, { required: ["text"] }];
  if (create.properties) {
    for (const name of ["html", "text"]) Object.assign(create.properties[name], { description: "Rendered content; maximum 2,000,000 UTF-8 bytes.", "x-maxUtf8Bytes": 2_000_000 });
    for (const name of ["tags", "metadata"]) Object.assign(create.properties[name], { maxProperties: 20 });
  }
  return Response.json({
    openapi: "3.1.0", info: { title: "Envoy Service API", version: "1.0.0", description: "Provider-neutral asynchronous email. Limits apply to every authenticated endpoint: 600 requests/minute/service, 4,200,000 request bytes, 2,000,000 UTF-8 bytes per rendered content part. Unknown outcomes are never automatically resent across providers." },
    servers: [{ url: `${new URL(request.url).origin}/api/v1` }], security: [{ bearerAuth: [] }],
    paths: {
      "/": { get: { security: [], summary: "API discovery", responses: { "200": { description: "Resource links" } } } },
      "/messages": {
        get: operation("List messages", page("Message"), [...pageParameters, query("status", { type: "string", enum: ["in_progress", "delivered", "completed", "canceled"] }), query("referenceId", { type: "string" })]),
        post: { ...operation("Queue rendered content; same key and payload replay the same acceptance", ref("AcceptedMessage"), [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 1, maxLength: 256 } }], "202"), ...body("CreateMessage") },
      },
      "/messages/{id}": { get: operation("Read message and recipient deliveries", ref("MessageDetail"), [id]) },
      "/messages/{id}/retry": { post: { ...operation("Retry eligible deliveries; skipped entries explain suppressed or ineligible recipients", { type: "object", required: ["messageId", "queued", "skipped"], properties: { messageId: { type: "string" }, queued: { type: "integer" }, skipped: { type: "array", items: { type: "object", required: ["deliveryId", "queued", "reason"], properties: { deliveryId: { type: "string" }, queued: { const: false }, reason: { type: "string" } } } } } }, [id], "202"), ...body("RetryMessage", false) } },
      "/messages/{id}/cancel": { post: operation("Cancel eligible deliveries before provider submission", { type: "object", properties: { messageId: { type: "string" }, canceled: { type: "integer" } } }, [id], "202") },
      "/deliveries": { get: operation("List recipient deliveries", page("Delivery"), [...pageParameters, query("messageId", { type: "string" }), query("status", { type: "string", enum: deliveryStatuses })]) },
      "/deliveries/{id}": { get: operation("Read normalized outcome, attempts and events", ref("DeliveryDetail"), [id]) },
      "/events": { get: operation("List events; IDs match callback envelope IDs", page("Event"), [...pageParameters, query("deliveryId", { type: "string" }), query("type", { type: "string", enum: eventTypes })]) },
      "/inbound-messages": { get: operation("List inbound mail owned by this service", page("Inbound"), pageParameters) },
      "/inbound-messages/{id}": { get: operation("Read sanitized content and attachment metadata", ref("InboundDetail"), [id]) },
      "/inbound-messages/{id}/attachments/{attachmentId}": { get: { summary: "Download a ready, policy-approved attachment owned by this service", parameters: [id, { ...id, name: "attachmentId" }], responses: { "200": { description: "Attachment download", headers: { ...headers, "Content-Disposition": { schema: { type: "string" } }, "X-Content-Type-Options": { schema: { const: "nosniff" } } }, content: { "application/octet-stream": { schema: { type: "string", contentEncoding: "binary" } } } }, ...errors } } },
      "/suppressions": { get: operation("List active product suppressions; an email filter includes applicable global records", { type: "object", properties: { data: { type: "array", items: ref("Suppression") } } }, [query("email", { type: "string", format: "email" })]), post: { ...operation("Create a suppression; duplicate returns 200", { type: "object", properties: { id: { type: "string" }, duplicate: { type: "boolean" } } }, [], "201"), ...body("CreateSuppression") } },
      "/suppressions/{id}": { delete: { summary: "Remove product-owned suppression", parameters: [id], responses: { "204": { description: "Removed", headers }, ...errors } } },
      "/senders": { get: operation("List logical sender profiles", { type: "object", properties: { data: { type: "array", items: ref("Sender") } } }) },
      "/capabilities": { get: operation("Discover fixed limits, supported features and senders", { type: "object", required: ["apiVersion", "service", "product", "limits", "content", "features", "senderProfiles", "resources"], properties: { apiVersion: { const: "v1" }, service: { type: "object" }, product: { type: "object" }, limits: { type: "object" }, content: { type: "object" }, features: { type: "object" }, senderProfiles: { type: "array", items: ref("Sender") }, resources: { type: "array", items: { type: "string" } } } }) },
    }, components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } }, schemas },
  });
}
