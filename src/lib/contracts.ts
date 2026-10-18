import { z } from "zod";

export const MAX_REQUEST_BYTES = 4_200_000;
export const MAX_CONTENT_BYTES = 2_000_000;
export const deliveryStatuses = ["queued", "submitting", "accepted", "deferred", "delivered", "bounced", "failed", "unknown", "canceled"] as const;
export const eventTypes = ["queued", "submitting", "accepted", "deferred", "delivered", "bounced", "failed", "opened", "clicked", "complained", "unsubscribed", "suppressed", "canceled", "unknown"] as const;
const contentSchema = z.string().refine(value => new TextEncoder().encode(value).byteLength <= MAX_CONTENT_BYTES, "Content must be at most 2000000 UTF-8 bytes");

export const MAX_FILE_BYTES = 10_000_000;
export const MAX_ATTACHMENT_BYTES = 20_000_000;
const headerSafe = z.string().refine(value => !/[\x00-\x1f\x7f]/.test(value), "Header values must not contain control characters");
export const emailAddressSchema = z.object({
  email: z.string().email().max(254),
  name: headerSafe.max(100).optional(),
}).strict();
export const outboundAttachmentInputSchema = z.object({
  fileId: z.string().min(1).max(160),
  fileName: headerSafe.min(1).max(255).refine(value => !/[\\/]/.test(value), "Use a plain file name").optional(),
  disposition: z.enum(["attachment", "inline"]).default("attachment"),
  contentId: z.string().min(1).max(200).regex(/^[^<>\s\x00-\x1f\x7f]+$/).optional(),
}).strict().refine(value => value.disposition !== "inline" || Boolean(value.contentId), { message: "Inline attachments require contentId", path: ["contentId"] })
  .refine(value => value.disposition === "inline" || value.contentId === undefined, { message: "contentId is only allowed for inline attachments", path: ["contentId"] });
const reservedHeader = /^(?:from|to|cc|bcc|subject|reply-to|sender|return-path|received(?:-.*)?|date|message-id|mime-version|content-.*|dkim-.*|authentication-results|arc-.*|in-reply-to|references|resent-.*|x-envoy-.*|x-ses-.*|x-sg-.*|x-mailgun-.*|x-pm-.*|x-smtpapi|disposition-notification-to|return-receipt-to)$/i;
export const createMessageSchema = z.object({
  category: z.string().min(2).max(80).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, "category must be a stable lowercase key").default("transactional"),
  from: emailAddressSchema,
  to: z.array(emailAddressSchema).max(50).default([]),
  cc: z.array(emailAddressSchema).max(50).default([]),
  bcc: z.array(emailAddressSchema).max(50).default([]),
  subject: headerSafe.max(998).default(""),
  html: contentSchema.optional(),
  text: contentSchema.optional(),
  replyTo: z.array(emailAddressSchema).max(10).default([]),
  attachments: z.array(outboundAttachmentInputSchema).max(20).default([]),
  headers: z.record(z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,78}$/).refine(value => !reservedHeader.test(value), "This header is maintained by Envoy"), headerSafe.max(998)).refine(value => Object.keys(value).length <= 30, "headers must contain at most 30 entries").default({}),
  inReplyTo: z.string().regex(/^<[^<>\s\x00-\x1f\x7f]+@[^<>\s\x00-\x1f\x7f]+>$/, "Use a bracketed RFC message ID").max(998).optional(),
  references: z.array(z.string().regex(/^<[^<>\s\x00-\x1f\x7f]+@[^<>\s\x00-\x1f\x7f]+>$/).max(998)).max(50).default([]),
  tags: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), z.string().max(256)).refine(value => Object.keys(value).length <= 20, "tags must contain at most 20 entries").optional(),
  referenceId: z.string().trim().min(1).max(160).optional(),
  metadata: z.record(z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/), z.string().max(500)).refine(value => Object.keys(value).length <= 20, "metadata must contain at most 20 entries").optional(),
}).strict().refine(input => Boolean(input.html || input.text), { message: "At least one of html or text must be nonempty", path: ["html"] }).superRefine((input, context) => {
  const count = input.to.length + input.cc.length + input.bcc.length;
  if (count < 1 || count > 50) context.addIssue({ code: "custom", path: ["to"], message: "To, Cc and Bcc must contain between 1 and 50 total recipients" });
  const recipients = new Set<string>();
  for (const role of ["to", "cc", "bcc"] as const) input[role].forEach((recipient, index) => {
    const normalized = recipient.email.toLowerCase();
    if (recipients.has(normalized)) context.addIssue({ code: "custom", path: [role, index, "email"], message: "Each recipient email can appear only once across To, Cc and Bcc" });
    recipients.add(normalized);
  });
  const names = Object.keys(input.headers).map(key => key.toLowerCase());
  if (new Set(names).size !== names.length) context.addIssue({ code: "custom", path: ["headers"], message: "Header names are case-insensitive and must be unique" });
  const ids = input.attachments.flatMap(item => item.contentId ? [item.contentId] : []);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["attachments"], message: "Attachment content IDs must be unique" });
});

export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export const retryMessageSchema = z.object({
  acknowledgeDuplicateRisk: z.boolean().default(false),
  deliveryIds: z.array(z.string().min(1)).min(1).max(50).refine(ids => new Set(ids).size === ids.length, "deliveryIds must be unique").optional(),
}).strict();

export const createSuppressionSchema = z.object({
  email: z.string().email(),
  scope: z.enum(["product", "list"]).default("product"),
  listId: z.string().trim().min(1).max(160).optional(),
  reason: z.string().trim().min(1).max(240),
  expiresAt: z.string().datetime({ offset: true }).optional(),
}).strict().refine(input => input.scope !== "list" || Boolean(input.listId), {
  message: "listId is required for list suppressions",
  path: ["listId"],
}).refine(input => input.scope !== "product" || !input.listId, {
  message: "listId is allowed only for list suppressions",
  path: ["listId"],
});

export type AcceptedMessage = {
  id: string;
  processingState: "queued";
  outcome: "pending";
  product: string;
  category: string;
  recipientCount: number;
  acceptedAt: string;
  referenceId?: string;
};

export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail: string;
  code?: string;
  requestId?: string;
  errors?: Record<string, string[]>;
};

const iso = z.string().datetime({ offset: true });
const nullableText = z.string().nullable();
export const processingStates = ["queued", "processing", "finished"] as const;
export const messageOutcomes = ["pending", "succeeded", "partially_failed", "failed", "canceled", "unknown"] as const;
export const diagnosticSchema = z.object({
  code: z.string(), message: z.string(), stage: z.string(),
  acceptance: z.enum(["not_accepted", "accepted", "unknown"]), retryable: z.boolean(),
  retryDecision: z.object({ action: z.enum(["scheduled", "none", "manual_review"]), nextAttemptAt: iso.optional(), reason: z.string().optional() }),
  providerCode: z.string().optional(), smtpStatus: z.string().optional(), occurredAt: iso.optional(),
});
export const deliverySummarySchema = z.object({
  id: z.string(), messageId: z.string(), recipient: z.string(), recipientName: nullableText, recipientRole: z.enum(["to", "cc", "bcc"]),
  subject: z.string(), category: z.string(), lifecycle: z.enum(deliveryStatuses),
  engagement: z.enum(["unopened", "opened", "clicked"]), compliance: z.enum(["clean", "complained", "unsubscribed", "suppressed"]),
  lastError: diagnosticSchema.nullable(), queuedAt: iso, updatedAt: iso,
});
export const publicEventSchema = z.object({
  id: z.string(), messageId: z.string(), deliveryId: z.string().nullable(), submissionId: z.string().optional(),
  type: z.string(), scope: z.enum(["recipient", "submission"]), occurredAt: iso,
  data: z.object({ attemptId: z.string().optional(), recipient: z.string().optional(), diagnostic: diagnosticSchema.optional(),
    bounce: z.object({ classification: z.enum(["hard", "soft"]), code: z.string().optional(), message: z.string().optional() }).optional(),
    reason: z.string().optional() }),
});
export const submissionAttemptSchema = z.object({
  id: z.string(), submissionId: z.string(), number: z.number(), status: z.string(),
  outcomeDeterminate: z.boolean(), error: diagnosticSchema.nullable(),
  rfcMessageId: nullableText, rfcMessageIdStatus: z.enum(["confirmed","unknown"]),
  startedAt: iso, finishedAt: iso.nullable(),
  recipients: z.array(z.object({ deliveryId: z.string(), email: z.string(), role: z.enum(["to", "cc", "bcc"]) })),
});
export const attachmentUsageSchema = z.object({
  state:z.enum(["processing","usable","unavailable"]),safetyState:z.enum(["pending","scanning","clean","malicious","unavailable","unscanned","purged","blocked"]),processing:z.boolean(),canSend:z.boolean(),canDownload:z.boolean(),
  reasonCode:z.string().nullable(),retryable:z.boolean(),recovery:z.enum(["poll","retry","none"]),
});
export const attachmentSchema = z.object({ id: z.string(), fileName: z.string(), contentType: z.string(), size: z.number(), contentId: nullableText,
  contentAvailable:z.boolean().describe("Whether content is retained, independent of use permission."),usage:attachmentUsageSchema });
export const outboundFileSchema = z.object({ id: z.string(), fileName: z.string(), contentType: z.string(), size: z.number(), sha256: z.string(), contentAvailable: z.boolean(),usage:attachmentUsageSchema, createdAt: iso });
export const outboundAttachmentSchema = z.object({ fileId: z.string(), fileName: z.string(), contentType: z.string(), size: z.number(), sha256: z.string(), disposition: z.enum(["attachment", "inline"]), contentId: nullableText });
export const inboundSummarySchema = z.object({ id: z.string(), from: z.string(), to: z.array(z.string()), subject: z.string(), status: z.enum(["scanning", "ready", "rejected"]), attachmentCount: z.number(), authorDate: iso.nullable(), ingressReceivedAt: iso.nullable(), readyAt: iso.nullable(), receivedAt: iso });
export const inboundDetailSchema = inboundSummarySchema.omit({ attachmentCount: true }).extend({ messageId: nullableText, envelopeRecipients: z.array(z.string()), replyTo: z.array(z.string()), inReplyTo: nullableText, references: z.array(z.string()), cc: z.array(z.string()), bcc: z.array(z.string()), html: nullableText, text: nullableText, contentPurgedAt: iso.nullable(), rejectionReason: nullableText, attachments: z.array(attachmentSchema) });
export const acceptedMessageSchema = z.object({ id: z.string(), processingState: z.literal("queued"), outcome: z.literal("pending"), product: z.string(), category: z.string(), recipientCount: z.number(), acceptedAt: iso, referenceId: z.string().optional() });
export const messageCountsSchema = z.object(Object.fromEntries([...deliveryStatuses, "suppressed"].map(key => [key, z.number().int().nonnegative()])));
export const messageSummarySchema = acceptedMessageSchema.extend({ processingState: z.enum(processingStates), outcome: z.enum(messageOutcomes), from: emailAddressSchema, subject: z.string(), referenceId: nullableText, counts: messageCountsSchema });
export const messageDetailSchema = messageSummarySchema.extend({
  requestId: nullableText, to: z.array(emailAddressSchema), cc: z.array(emailAddressSchema), bcc: z.array(emailAddressSchema),
  html: nullableText, text: nullableText, contentPurgedAt: iso.nullable(), replyTo: z.array(emailAddressSchema),
  headers: z.record(z.string(), z.string()), inReplyTo: nullableText, references: z.array(z.string()), attachments: z.array(outboundAttachmentSchema),
  metadata: z.record(z.string(), z.string()), tags: z.record(z.string(), z.string()),
  deliveries: z.array(deliverySummarySchema.omit({ messageId: true, subject: true, category: true, queuedAt: true })),
});
export const deliveryDetailSchema = deliverySummarySchema.extend({ referenceId: nullableText, acceptedAt: iso.nullable(), deliveredAt: iso.nullable(), attempts: z.array(submissionAttemptSchema), events: z.array(publicEventSchema) });
export const problemDetailsSchema = z.object({ type: z.string(), title: z.string(), status: z.number(), detail: z.string(), code: z.string(), requestId: z.string(), errors: z.record(z.string(), z.array(z.string())).optional() });
export const requestDiagnosticSchema = z.object({ requestId: z.string(), method: z.string(), path: z.string(), statusCode: z.number(), durationMs: z.number(), messageId: nullableText, createdAt: iso, problem: problemDetailsSchema.nullable() });
export const suppressionSchema = z.object({ id: z.string(), scope: z.enum(["global", "product", "list"]), listId: nullableText, email: z.string(), reason: z.string(), source: z.string(), expiresAt: iso.nullable(), createdAt: iso });

// Public discovery contains configuration facts separately from transport evidence.
const mailReasonSchema = z.enum(["SENDER_NOT_AUTHORIZED", "SENDING_DOMAIN_DISABLED", "NO_ELIGIBLE_ROUTE", "INBOUND_ROUTE_DISABLED", "INBOUND_DOMAIN_DISABLED", "INBOUND_INGRESS_UNAVAILABLE", "ENVELOPE_RECIPIENT_UNAVAILABLE"]);
const mailPermissionBase = { id: z.string(), domain: z.string(), displayName: nullableText };
const senderPermissionSchema = z.object({ ...mailPermissionBase, scope: z.enum(["product", "service"]), authorization: z.enum(["granted", "revoked"]),
  sending: z.object({ state: z.enum(["configured", "unavailable"]), reasonCodes: z.array(mailReasonSchema), categories: z.array(nullableText), runtimeAvailability: z.literal("unknown") }),
  evidence: z.object({ lastAcceptedAt: iso.nullable(), lastDeliveredAt: iso.nullable() }),
});
const receiverPermissionSchema = z.object({ ...mailPermissionBase, localPartPattern: z.string(),
  receiving: z.object({ state: z.enum(["configured", "unavailable"]), reasonCodes: z.array(mailReasonSchema), externalReadiness: z.literal("unknown") }),
  notification: z.object({ mode:z.enum(["polling","callback_and_polling"]),state:z.enum(["configured","unavailable"]),
    callbackEndpointId:nullableText,reasonCodes:z.array(z.enum(["CALLBACK_BINDING_INVALID","CALLBACK_DISABLED","CALLBACK_EVENT_NOT_SUBSCRIBED"])),recoveryResource:z.literal("/api/v1/inbound-changes") }),
  evidence: z.object({ lastReceivedAt: iso.nullable() }),
});
export const mailDiscoverySchema = z.object({
  kind: z.literal("address_permissions"), mailboxLogin: z.literal(false),
  senders: z.array(z.discriminatedUnion("kind", [
    senderPermissionSchema.extend({ kind: z.literal("exact_address"), address: z.email() }),
    senderPermissionSchema.extend({ kind: z.literal("domain"), address: z.null() }),
  ])),
  receivers: z.array(z.discriminatedUnion("kind", [
    receiverPermissionSchema.extend({ kind: z.literal("exact_address"), address: z.email() }),
    receiverPermissionSchema.extend({ kind: z.literal("local_part_pattern"), address: z.null() }),
  ])),
  callbacks: z.object({ configuration: z.enum(["configured", "unavailable"]), businessProcessing: z.literal("unknown"), lastDeliveredAt: iso.nullable(),
    latest: z.object({ status: z.enum(["pending", "delivering", "delivered", "retrying", "dead_letter", "terminated"]), attemptCount: z.number().int(), deliveredAt: iso.nullable() }).nullable(),
  }),
});

export const inboundReceivedEventSchema = z.object({
  id: z.string(), apiVersion: z.literal("2026-09-01"), type: z.literal("inbound.received"), occurredAt: iso,
  data: z.object({ authorDate: iso.nullable(), ingressReceivedAt: iso.nullable(), readyAt: iso.nullable(), inboundMessageId: z.string(), productId: z.string(), serviceId: z.string(),
    envelopeRecipients: z.array(z.string()), messageId: nullableText, replyTo: z.array(z.string()), inReplyTo: nullableText, references: z.array(z.string()),
    from: z.string(), to: z.array(z.string()), cc: z.array(z.string()), subject: z.string(),
    attachments: z.array(z.object({ fileName: z.string(), contentType: z.string(), size: z.number() })),
  }),
});

export const inboundChangeSchema = z.object({ id:z.string(),inboundMessageId:z.string(),type:z.enum(["inbound.available","inbound.content_purged"]),recordedAt:iso,cursor:z.string() });
export const inboundChangePageSchema = z.object({ data:z.array(inboundChangeSchema),nextCursor:z.string(),hasMore:z.boolean(),watermark:z.string(),
  retention:z.object({ earliestCursor:z.string(),historyTruncated:z.boolean(),days:z.literal(90) }) });
export const contentPurgeSchema = z.object({ id:z.string(),contentPurgedAt:iso,objectDeletion:z.literal("pending_or_complete") });
