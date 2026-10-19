import { serviceRoute, apiProblem } from "@/server/service-api";
import { getMessage } from "@/modules/outbound/public";

export const runtime = "nodejs";

export const GET = serviceRoute(async (request, identity, context: { params: Promise<{ id: string }> }) => {

  const message = await getMessage((await context.params).id, identity.serviceId);
  if (!message) {
    return apiProblem("Not found", 404);
  }

  return Response.json({
    id: message.id,
    contentPolicy: message.content_policy,
    sendBefore: message.send_before?.toISOString() ?? null,
    processingState: message.processing_state,
    outcome: message.outcome,
    counts: message.counts,
    requestId: message.request_id,
    from: { email: message.sender_snapshot.fromEmail, ...(message.sender_snapshot.fromName !== undefined ? { name: message.sender_snapshot.fromName } : {}) },
    to: message.to_recipients,
    cc: message.cc_recipients,
    bcc: message.bcc_recipients,
    headers: message.headers,
    inReplyTo: message.in_reply_to,
    references: message.references_ids,
    attachments: (message.content_policy === "sensitive" ? [] : message.attachment_snapshot).map(attachment => ({ fileId: attachment.fileId, fileName: attachment.fileName, contentType: attachment.contentType, size: attachment.size, sha256: attachment.sha256, disposition: attachment.disposition, contentId: attachment.contentId })),
    product: message.product,
    category: message.category,
    subject: message.subject,
    html: message.html_body,
    text: message.text_body,
    contentPurgedAt: message.content_purged_at?.toISOString() ?? null,
    replyTo: message.reply_to,
    metadata: message.metadata,
    tags: message.provider_tags,
    recipientCount: message.recipient_count,
    acceptedAt: message.accepted_at.toISOString(),
    referenceId: message.reference_id,
    deliveries: message.deliveries.map(delivery => ({
      id: delivery.id,
      recipient: delivery.recipient_email,
      recipientName: delivery.recipient_name,
      recipientRole: delivery.recipient_role,
      lastError: delivery.last_error,
      lifecycle: delivery.lifecycle_status,
      engagement: delivery.engagement_status,
      compliance: delivery.compliance_status,
      updatedAt: delivery.updated_at.toISOString(),
      acceptedAt: delivery.accepted_at?.toISOString() ?? null,
      deliveredAt: delivery.delivered_at?.toISOString() ?? null
    })),
  });
});
