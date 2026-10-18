import { z } from "zod";
import { contentPurgeSchema, inboundChangePageSchema, inboundReceivedEventSchema, mailDiscoverySchema, createMessageSchema, createSuppressionSchema, retryMessageSchema, deliveryStatuses, eventTypes, acceptedMessageSchema, messageSummarySchema, messageDetailSchema, deliverySummarySchema, deliveryDetailSchema, publicEventSchema, inboundSummarySchema, inboundDetailSchema, suppressionSchema, problemDetailsSchema, outboundFileSchema, requestDiagnosticSchema, submissionAttemptSchema, processingStates, messageOutcomes } from "@/lib/contracts";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ "application/json": { schema } });
const page = (name: string) => ({ type: "object", required: ["data", "nextCursor"], properties: { data: { type: "array", items: ref(name) }, nextCursor: { type: ["string", "null"] } } });
const query = (name: string, schema: object) => ({ name, in: "query", schema });
const pageParameters = [query("limit", { type: "integer", minimum: 1, maximum: 100, default: 50 }), query("cursor", { type: "string", description: "Opaque cursor from nextCursor; retain the same filters. Inbound browse cursors use inbound.; inbound-changes uses independent service stream cursors." })];
const id = { name: "id", in: "path", required: true, schema: { type: "string" } };
const headers = { "X-Request-ID": { schema: { type: "string" } }, "RateLimit-Limit": { schema: { type: "integer" } }, "RateLimit-Remaining": { schema: { type: "integer" } }, "RateLimit-Reset": { description: "Seconds until the current fixed window resets", schema: { type: "integer" } } };
const error = (description: string) => ({ description, content: { "application/problem+json": { schema: ref("Problem") } }, headers });
const errors = { "400": error("Invalid syntax, cursor or filter"), "401": { ...error("Missing or invalid bearer credential"), headers: { ...headers, "WWW-Authenticate": { schema: { type: "string" } } } }, "410": error("Inbound cursor expired; history gap requires reconciliation"), "404": error("Resource unavailable or not owned by this service"), "409": error("Idempotency conflict, duplicate risk acknowledgement, CONTENT_BUSY, CONTENT_SHARED, FILE_NOT_READY or FILE_UNAVAILABLE"), "413": error("Request byte limit exceeded"), "415": error("Unsupported content type"), "422": error("Contract or business validation failed"), "429": { ...error("Service request limit exceeded"), headers: { ...headers, "Retry-After": { schema: { type: "integer" } } } }, "503": error("Dependency temporarily unavailable; retry writes using the same idempotency key") };
function operation(summary: string, schema: object, parameters: object[] = [], status = "200") { return { summary, parameters, responses: { [status]: { description: "Success", headers, content: json(schema) }, ...errors } }; }
const body = (name: string, required = true) => ({ requestBody: { required, content: json(ref(name)) } });

export function GET(request: Request) {
  const schemas = Object.fromEntries(Object.entries({ ContentPurge:contentPurgeSchema, InboundChangePage:inboundChangePageSchema, InboundReceivedEvent: inboundReceivedEventSchema, MailDiscovery: mailDiscoverySchema, CreateMessage: createMessageSchema, RetryMessage: retryMessageSchema, CreateSuppression: createSuppressionSchema, AcceptedMessage: acceptedMessageSchema, Message: messageSummarySchema, MessageDetail: messageDetailSchema, Delivery: deliverySummarySchema, DeliveryDetail: deliveryDetailSchema, Event: publicEventSchema, Inbound: inboundSummarySchema, InboundDetail: inboundDetailSchema, Suppression: suppressionSchema, File: outboundFileSchema, RequestDiagnostic: requestDiagnosticSchema, SubmissionAttempt: submissionAttemptSchema, Problem: problemDetailsSchema }).map(([name, schema]) => [name, z.toJSONSchema(schema, { unrepresentable: "any" })]));
  // Cross-field and UTF-8 byte constraints cannot be inferred from Zod refinements.
  const create = schemas.CreateMessage;
  create.anyOf = [{ required: ["html"], properties: { html: { minLength: 1 } } }, { required: ["text"], properties: { text: { minLength: 1 } } }];
  create.description = "From is supplied directly and must be authorized by a sender grant. To, Cc and Bcc together contain 1–50 unique recipients. Recipient roles and visible headers are preserved. Inline attachments require unique contentId. Header names are case-insensitive and may not repeat; system, routing and authentication headers are reserved. Attachments belong to this service, are retained and currently safety-approved, total at most 20 MB and each file is at most 10 MB. Only supported eligible routes are used; unsupported features fail explicitly.";
  create["x-totalRecipientMinimum"] = 1;
  create["x-totalRecipientMaximum"] = 50;
  if (create.properties) {
    for (const name of ["html", "text"]) Object.assign(create.properties[name], { description: "Rendered content; maximum 2,000,000 UTF-8 bytes.", "x-maxUtf8Bytes": 2_000_000 });
    for (const name of ["tags", "metadata"]) Object.assign(create.properties[name], { maxProperties: 20 });
  }
  return Response.json({
    openapi: "3.1.0", info: { title: "Envoy Service API", version: "1.0.0", description: "Provider-neutral asynchronous email with native From, To, Cc, Bcc, Reply-To, attachments and threading. 202 means durable platform acceptance, not delivery. Status queries distinguish progress from outcome. Service request IDs correlate pre-acceptance failures; diagnostics are available without console access. Limits apply to every authenticated endpoint: 600 requests/minute/service, 4,200,000 request bytes, 2,000,000 UTF-8 bytes per rendered content part. Unknown outcomes are never automatically resent across providers." },
    servers: [{ url: `${new URL(request.url).origin}/api/v1` }], security: [{ bearerAuth: [] }],
    paths: {
      "/": { get: { security: [], summary: "API discovery", responses: { "200": { description: "Resource links" } } } },
      "/messages": {
        get: operation("List messages", page("Message"), [...pageParameters, query("processingState", { type: "string", enum: processingStates }), query("outcome", { type: "string", enum: messageOutcomes }), query("referenceId", { type: "string" })]),
        post: { ...operation("Queue rendered content; same key and payload replay the same acceptance", ref("AcceptedMessage"), [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 1, maxLength: 256 } }], "202"), ...body("CreateMessage") },
      },
      "/messages/{id}": { get: operation("Read message and recipient deliveries", ref("MessageDetail"), [id]) },
      "/messages/{id}/retry": { post: { ...operation("Retry eligible deliveries; skipped entries explain suppressed or ineligible recipients", { type: "object", required: ["messageId", "queued", "skipped"], properties: { messageId: { type: "string" }, queued: { type: "integer" }, skipped: { type: "array", items: { type: "object", required: ["deliveryId", "queued", "reason"], properties: { deliveryId: { type: "string" }, queued: { const: false }, reason: { type: "string" } } } } } }, [id, { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 1, maxLength: 256 } }], "202"), ...body("RetryMessage", false) } },
      "/messages/{id}/cancel": { post: operation("Cancel eligible deliveries before provider submission", { type: "object", properties: { messageId: { type: "string" }, canceled: { type: "integer" } } }, [id], "202") },
      "/deliveries": { get: operation("List recipient deliveries", page("Delivery"), [...pageParameters, query("messageId", { type: "string" }), query("status", { type: "string", enum: deliveryStatuses })]) },
      "/deliveries/{id}": { get: operation("Read normalized outcome, attempts and events", ref("DeliveryDetail"), [id]) },
      "/events": { get: operation("List events; IDs match callback envelope IDs", page("Event"), [...pageParameters, query("deliveryId", { type: "string" }), query("messageId", { type: "string" }), query("type", { type: "string", enum: eventTypes })]) },
      "/inbound-changes": { get: operation("Recover service inbound availability and content-purge changes in committed order; always persist nextCursor after durable processing. Omitted cursor starts at retained floor with explicit truncation flag; expired cursors return 410 INBOUND_CURSOR_EXPIRED.",ref("InboundChangePage"),pageParameters) },
      "/inbound-messages/{id}/content": { delete:operation("Idempotently clear this service copy and terminate undelivered callbacks; scanning or delivering work returns 409 CONTENT_BUSY",ref("ContentPurge"),[id],"202") },
      "/messages/{id}/content": { delete:operation("Idempotently clear terminal content; active or unknown attempts return 409 CONTENT_BUSY; shared files remain retained",ref("ContentPurge"),[id],"202") },
      "/files/{id}/content": { delete:operation("Clear an unreferenced service-owned file; retained message snapshots return 409 CONTENT_SHARED",ref("ContentPurge"),[id],"202") },
      "/inbound-messages": { get: operation("List inbound mail owned by this service", page("Inbound"), pageParameters) },
      "/inbound-messages/{id}": { get: operation("Read sanitized content and attachment metadata", ref("InboundDetail"), [id]) },
      "/inbound-messages/{id}/attachments/{attachmentId}": { get: { summary: "Download a ready, policy-approved attachment owned by this service", parameters: [id, { ...id, name: "attachmentId" }], responses: { "200": { description: "Attachment download", headers: { ...headers, "Content-Disposition": { schema: { type: "string" } }, "X-Content-Type-Options": { schema: { const: "nosniff" } } }, content: { "application/octet-stream": { schema: { type: "string", contentEncoding: "binary" } } } }, ...errors } } },
      "/suppressions": { get: operation("List active product suppressions; an email filter includes applicable global records", { type: "object", properties: { data: { type: "array", items: ref("Suppression") } } }, [query("email", { type: "string", format: "email" })]), post: { ...operation("Create a suppression; duplicate returns 200", { type: "object", properties: { id: { type: "string" }, duplicate: { type: "boolean" } } }, [], "201"), ...body("CreateSuppression") } },
      "/suppressions/{id}": { delete: { summary: "Remove product-owned suppression", parameters: [id], responses: { "204": { description: "Removed", headers }, ...errors } } },
      "/messages/{id}/events": { get: operation("Read recipient and submission events with structured diagnostics; IDs match callbacks", page("Event"), [id, ...pageParameters]) },
      "/messages/{id}/attempts": { get: operation("Read service-scoped submission attempts and associated recipients", page("SubmissionAttempt"), [id, ...pageParameters]) },
      "/requests/{requestId}": { get: operation("Read an authenticated request, including rejection before message acceptance", ref("RequestDiagnostic"), [{ ...id, name: "requestId" }]) },
      "/files": { post: {
        ...operation("Reliably receive private bytes and schedule safety processing; 201 does not mean usable", ref("File"), [{ name: "X-File-Name", in: "header", required: true, description: "URI-encoded UTF-8 plain file name, max 255 decoded characters", schema: { type: "string" } }], "201"),
        requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", contentEncoding: "binary", "x-maxBytes": 10_000_000 } } }, description: "Raw nonempty file bytes, max 10,000,000 bytes; Content-Type can be any valid media type without parameters." },
      } },
      "/files/{id}/download": {get:{summary:"Download retained, safety-approved service-owned bytes",parameters:[id],responses:{"200":{description:"Private download",content:{"application/octet-stream":{schema:{type:"string",contentEncoding:"binary"}}}},...errors}}},
      "/files/{id}/reprocess": {post:operation("Request audited reprocessing; malicious, integrity-blocked or purged resources cannot be retried",{type:"object",properties:{id:{type:"string"},processing:{const:true}}},[id],"202")},
      "/inbound-messages/{id}/attachments/{attachmentId}/reprocess": {post:operation("Request audited reprocessing of this service attachment",{type:"object",properties:{id:{type:"string"},processing:{const:true}}},[id,{...id,name:"attachmentId"}],"202")},
      "/files/{id}": { get: operation("Read attachment metadata owned by this service; storage keys are private", ref("File"), [id]) },
      "/capabilities": { get: operation("Discover product/service, address permissions, inbound routes, configuration readiness and transport evidence", { type: "object", required: ["apiVersion", "service", "product", "limits", "content", "features", "mail", "attachmentSafety", "routing", "resources"], properties: {
        apiVersion: { const: "v1" },
        service: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } },
        product: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } },
        limits: { type: "object", properties: { recipientsPerMessage: { const: 50 }, contentBytesPerPart: { const: 2_000_000 }, requestBytes: { const: 4_200_000 }, fileBytes: { const: 10_000_000 }, attachmentsPerMessage: { const: 20 }, attachmentBytesPerMessage: { const: 20_000_000 }, metadataEntries: { const: 20 }, requestsPerMinute: { type: "integer" } } },
        content: { type: "object", properties: { ownership: { const: "caller" }, formats: { type: "array", items: { enum: ["text/plain", "text/html"] } }, requiresRenderedContent: { const: true } } },
        features: { type: "object", additionalProperties: { type: ["boolean", "string"] } },
        mail: { ...ref("MailDiscovery"), description: "Service-scoped address permissions, never mailbox login credentials. Configuration and historical evidence do not guarantee current delivery." },
        attachmentSafety: {type:"object",required:["processing","mode","policyVersion","runtimeAvailability"],properties:{processing:{const:"asynchronous"},mode:{const:"require_clean"},policyVersion:{type:"string"},runtimeAvailability:{const:"unknown"}}},
        routing: { type: "string" }, resources: { type: "array", items: { type: "string" } },
      } }) },
    },
    webhooks: {
      inboundReceived: { post: {
        summary: "Signed inbound receipt; HTTP success acknowledges durable receipt, not completed business processing",
        description: "At least once. Reject timestamps outside your replay window; verify HMAC-SHA256(timestamp + '.' + raw body) in constant time. Deduplicate on x-envoy-id, which equals payload.id. Use the service key to fetch content and attachments. Only this service's matched SMTP recipients are included.",
        security: [], parameters: [
          { name: "x-envoy-key-version", in:"header", required:true, description:"Signing key version; unrelated to payload apiVersion or signature algorithm v1", schema:{type:"string"} },
          { name: "x-envoy-id", in: "header", required: true, schema: { type: "string" } },
          { name: "x-envoy-timestamp", in: "header", required: true, schema: { type: "string", pattern: "^[0-9]+$" } },
          { name: "x-envoy-signature", in: "header", required: true, schema: { type: "string", pattern: "^v1=[a-f0-9]{64}$" } },
        ],
        requestBody: { required: true, content: json(ref("InboundReceivedEvent")) },
        responses: { "2XX": { description: "Durably received; business processing state is unknown to Envoy" }, default: { description: "Delivery failed; Envoy retries and eventually dead-letters" } },
      } },
    }, components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } }, schemas },
  });
}
