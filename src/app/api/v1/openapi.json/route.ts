const bearer = [{ bearerAuth: [] }];
const pageParameters = [
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
  { name: "cursor", in: "query", schema: { type: "string" } },
];

export function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return Response.json({
    openapi: "3.1.0",
    info: {
      title: "Envoy Service API",
      version: "1.0.0",
      description: "Provider-neutral asynchronous email delivery. Callers own rendering; Envoy owns sender resolution, routing, delivery, events, inbound mail, and suppression enforcement.",
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: bearer,
    paths: {
      "/": {
        get: {
          security: [],
          summary: "Discover API resources",
          responses: { "200": { description: "API discovery" } }
        }
      },
      "/messages": {
        get: {
          summary: "List messages",
          parameters: pageParameters,
          responses: { "200": { description: "Cursor page of messages" } }
        },
        post: {
          summary: "Queue a rendered email",
          parameters: [{
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string", maxLength: 256 }
          }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CreateMessage" } } }
          },
          responses: {
            "202": { description: "Message accepted" },
            "409": { description: "Idempotency conflict" },
            "422": { description: "Validation failed" }
          },
        },
      },
      "/messages/{id}": {
        get: {
          summary: "Get a message and recipient deliveries",
          parameters: [{ $ref: "#/components/parameters/Id" }],
          responses: { "200": { description: "Message" }, "404": { description: "Not found" } }
        }
      },
      "/messages/{id}/cancel": {
        post: {
          summary: "Cancel deliveries that have not crossed the provider boundary",
          parameters: [{ $ref: "#/components/parameters/Id" }],
          responses: { "202": { description: "Cancellation accepted" } }
        }
      },
      "/messages/{id}/retry": {
        post: {
          summary: "Retry eligible failed, deferred, or unknown deliveries",
          parameters: [{ $ref: "#/components/parameters/Id" }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { acknowledgeDuplicateRisk: { type: "boolean", default: false } },
                  additionalProperties: false
                }
              }
            }
          },
          responses: {
            "202": { description: "Retry accepted" },
            "409": { description: "Duplicate-risk acknowledgement required" }
          },
        },
      },
      "/deliveries": {
        get: {
          summary: "List recipient deliveries",
          parameters: [...pageParameters, {
            name: "messageId",
            in: "query",
            schema: { type: "string" }
          }, { name: "status", in: "query", schema: { type: "string" } }],
          responses: { "200": { description: "Cursor page of deliveries" } }
        }
      },
      "/deliveries/{id}": {
        get: {
          summary: "Get a delivery with attempts and canonical events",
          parameters: [{ $ref: "#/components/parameters/Id" }],
          responses: { "200": { description: "Delivery" } }
        }
      },
      "/events": {
        get: {
          summary: "List canonical delivery events",
          parameters: [...pageParameters, {
            name: "deliveryId",
            in: "query",
            schema: { type: "string" }
          }, { name: "type", in: "query", schema: { type: "string" } }],
          responses: { "200": { description: "Cursor page of events" } }
        }
      },
      "/inbound-messages": {
        get: {
          summary: "List routed inbound messages",
          parameters: pageParameters,
          responses: { "200": { description: "Cursor page of inbound messages" } }
        }
      },
      "/inbound-messages/{id}": {
        get: {
          summary: "Get sanitized inbound content and attachment metadata",
          parameters: [{ $ref: "#/components/parameters/Id" }],
          responses: { "200": { description: "Inbound message" } }
        }
      },
      "/suppressions": {
        get: {
          summary: "List product suppressions or check one address",
          parameters: [{ name: "email", in: "query", schema: { type: "string", format: "email" } }],
          responses: { "200": { description: "Suppressions" } }
        },
        post: {
          summary: "Create a product or list suppression",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CreateSuppression" } } }
          },
          responses: { "201": { description: "Suppression created" } }
        },
      },
      "/suppressions/{id}": {
        delete: {
          summary: "Remove a product-owned suppression",
          parameters: [{ $ref: "#/components/parameters/Id" }],
          responses: { "204": { description: "Suppression removed" } }
        }
      },
      "/senders": {
        get: {
          summary: "List active logical sender profiles",
          responses: { "200": { description: "Sender profiles" } }
        }
      },
      "/capabilities": {
        get: {
          summary: "Discover service limits and available senders",
          responses: { "200": { description: "Capabilities" } }
        }
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      parameters: { Id: { name: "id", in: "path", required: true, schema: { type: "string" } } },
      schemas: {
        Recipient: {
          type: "object",
          required: ["email"],
          properties: { email: { type: "string", format: "email" }, name: { type: "string", maxLength: 100 } },
          additionalProperties: false,
        },
        CreateMessage: {
          type: "object",
          required: ["to", "subject"],
          properties: {
            category: { type: "string", default: "transactional" },
            senderProfile: { type: "string" },
            to: { type: "array", minItems: 1, maxItems: 50, items: { $ref: "#/components/schemas/Recipient" } },
            subject: { type: "string", maxLength: 998 },
            html: { type: "string", maxLength: 2000000 },
            text: { type: "string", maxLength: 2000000 },
            replyTo: { type: "string", format: "email" },
            tags: { type: "object", additionalProperties: { type: "string", maxLength: 256 } },
            referenceId: { type: "string", maxLength: 160 },
            metadata: { type: "object", additionalProperties: { type: "string", maxLength: 500 } },
          },
          anyOf: [{ required: ["html"] }, { required: ["text"] }],
          additionalProperties: false,
        },
        CreateSuppression: {
          type: "object",
          required: ["email", "reason"],
          properties: {
            email: { type: "string", format: "email" },
            scope: { type: "string", enum: ["product", "list"], default: "product" },
            listId: { type: "string" },
            reason: { type: "string" },
            expiresAt: { type: "string", format: "date-time" },
          },
          additionalProperties: false,
        },
      },
    },
  });
}
