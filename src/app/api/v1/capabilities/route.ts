import { listSenderProfiles } from "@/modules/core/resources/service";
import { serviceRoute } from "@/server/service-api";

export const GET = serviceRoute(async (request, identity) => {
  return Response.json({
    apiVersion: "v1",
    service: { id: identity.serviceId, name: identity.serviceName },
    product: { id: identity.productId, name: identity.product },
    limits: {
      recipientsPerMessage: 50,
      contentBytesPerPart: 2_000_000,
      requestBytes: 4_200_000,
      metadataEntries: 20,
      requestsPerMinute: identity.rateLimitPerMinute
    },
    features: { outboundAttachments: false, scheduling: false, inboundAttachments: true, unknownOutcomeResolution: "best_effort_with_manual_review" },
    content: { ownership: "caller", formats: ["text/plain", "text/html"], requiresRenderedContent: true },
    senderProfiles: await listSenderProfiles(identity.productId),
    resources: ["messages", "deliveries", "events", "inbound-messages", "suppressions", "senders"],
  });
});
