import { listSenderProfiles } from "@/modules/core/resources/service";
import { authenticateService } from "@/server/auth";
import { apiProblem } from "@/server/service-api";

export async function GET(request: Request) {
  const identity = await authenticateService(request);
  if (!identity) return apiProblem("Unauthorized", 401, "A valid Envoy service credential is required.");
  return Response.json({
    apiVersion: "v1",
    service: { id: identity.serviceId, name: identity.serviceName },
    product: { id: identity.productId, name: identity.product },
    limits: {
      recipientsPerMessage: 50,
      contentBytesPerPart: 2_000_000,
      requestsPerMinute: identity.rateLimitPerMinute
    },
    content: { ownership: "caller", formats: ["text/plain", "text/html"], requiresRenderedContent: true },
    senderProfiles: await listSenderProfiles(identity.productId),
    resources: ["messages", "deliveries", "events", "inbound-messages", "suppressions", "senders"],
  });
}
