import { authenticateService } from "@/server/auth";
import { getMessage } from "@/modules/core/message/service";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const identity = await authenticateService(request);
  if (!identity) {
    return Response.json({ title: "Unauthorized", status: 401 }, { status: 401 });
  }

  const message = await getMessage((await context.params).id, identity.serviceId);
  if (!message) {
    return Response.json({ title: "Not found", status: 404 }, { status: 404 });
  }

  return Response.json({
    id: message.id,
    status: message.status,
    product: message.product,
    category: message.category,
    senderProfile: message.sender_profile,
    subject: message.subject,
    html: message.html_body,
    text: message.text_body,
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
      lifecycle: delivery.lifecycle_status,
      engagement: delivery.engagement_status,
      compliance: delivery.compliance_status,
      updatedAt: delivery.updated_at.toISOString()
    })),
  });
}
