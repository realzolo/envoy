import { messagePolicies } from "@/modules/outbound/public";
import { discoverMail } from "@/modules/identity/public";
import { MAX_ATTACHMENT_BYTES, MAX_CONTENT_BYTES, MAX_FILE_BYTES, MAX_REQUEST_BYTES } from "@/lib/contracts";
import { scanPolicy } from "@/modules/attachments/public";
import { serviceRoute } from "@/server/service-api";

export const GET = serviceRoute(async (_request, identity) => {
  return Response.json({
    apiVersion: "v1", service: { id: identity.serviceId, name: identity.serviceName },
    limits: { recipientsPerMessage: 50, contentBytesPerPart: MAX_CONTENT_BYTES, requestBytes: MAX_REQUEST_BYTES, fileBytes: MAX_FILE_BYTES, attachmentsPerMessage: 20, attachmentBytesPerMessage: MAX_ATTACHMENT_BYTES, metadataEntries: 20, requestsPerMinute: identity.rateLimitPerMinute },
    features: { nativeFrom: true, cc: true, bcc: true, replyTo: true, customHeaders: true, threading: true, outboundAttachments: true, inlineAttachments: true, scheduling: false, inboundAttachments: true, unknownOutcomeResolution: "best_effort_with_manual_review" },
    content: { ownership: "caller", formats: ["text/plain", "text/html"], requiresRenderedContent: true },
    mail: await discoverMail(identity),
    messagePolicies,
    attachmentSafety: { processing:"asynchronous",mode:"require_clean",policyVersion:scanPolicy().version,runtimeAvailability:"unknown" },
    routing: "Submission-time routing checks authorization, configured routing rules, provider identity and requested capabilities; configuration does not guarantee current routing availability.",
    resources: ["messages", "deliveries", "events", "requests", "files", "inbound-messages", "inbound-changes", "outbound-changes", "suppressions", "capabilities"],
  });
});
