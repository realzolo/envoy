import { discoverMail } from "@/modules/core/resources/capabilities";
import { MAX_ATTACHMENT_BYTES, MAX_CONTENT_BYTES, MAX_FILE_BYTES, MAX_REQUEST_BYTES } from "@/lib/contracts";
import { providerRegistry } from "@/modules/providers/registry";
import type { ProviderType } from "@/modules/providers/contracts";
import { query } from "@/server/database";
import { serviceRoute } from "@/server/service-api";

export const GET = serviceRoute(async (_request, identity) => {
  const grants = await query<{ id: string; domain: string; from_local_part: string | null; service_id: string | null }>(`SELECT g.id,sd.domain,g.from_local_part,g.service_id FROM sender_grants g
    JOIN sending_domains sd ON sd.id=g.sending_domain_id
    WHERE g.product_id=$1 AND (g.service_id IS NULL OR g.service_id=$2) AND g.status='active' AND sd.status='active'
    ORDER BY sd.domain,g.from_local_part NULLS FIRST,g.id`, [identity.productId,identity.serviceId]);
  const providers = await query<{ type: ProviderType; domain: string }>(`SELECT DISTINCT pa.type,sd.domain FROM provider_accounts pa
    JOIN provider_identities pi ON pi.provider_account_id=pa.id JOIN sending_domains sd ON sd.id=pi.sending_domain_id
    JOIN sender_grants g ON g.sending_domain_id=sd.id
    WHERE g.product_id=$1 AND (g.service_id IS NULL OR g.service_id=$2) AND g.status='active' AND sd.status='active'
      AND pa.status='active' AND pi.status='verified' ORDER BY sd.domain,pa.type`, [identity.productId,identity.serviceId]);
  return Response.json({
    apiVersion: "v1", service: { id: identity.serviceId, name: identity.serviceName }, product: { id: identity.productId, name: identity.product },
    limits: { recipientsPerMessage: 50, contentBytesPerPart: MAX_CONTENT_BYTES, requestBytes: MAX_REQUEST_BYTES, fileBytes: MAX_FILE_BYTES, attachmentsPerMessage: 20, attachmentBytesPerMessage: MAX_ATTACHMENT_BYTES, metadataEntries: 20, requestsPerMinute: identity.rateLimitPerMinute },
    features: { nativeFrom: true, cc: true, bcc: true, replyTo: true, customHeaders: true, threading: true, outboundAttachments: true, inlineAttachments: true, scheduling: false, inboundAttachments: true, unknownOutcomeResolution: "best_effort_with_manual_review" },
    content: { ownership: "caller", formats: ["text/plain", "text/html"], requiresRenderedContent: true },
    mail: await discoverMail(identity),
    senderGrants: grants.rows.map(row => ({ id: row.id, domain: row.domain, localPart: row.from_local_part, scope: row.service_id ? "service" : "product" })),
    providerCapabilities: providers.rows.map(row => ({ type: row.type, domain: row.domain, ...providerRegistry(row.type).descriptor.capabilities })),
    routing: "Submission-time routing checks authorization, configured routing rules, provider identity and requested capabilities; listed providers do not guarantee current routing availability.",
    resources: ["messages", "deliveries", "events", "requests", "files", "inbound-messages", "suppressions", "capabilities"],
  });
});
