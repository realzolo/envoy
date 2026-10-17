import { z } from "zod";

export const MAX_REQUEST_BYTES = 4_200_000;
export const MAX_CONTENT_BYTES = 2_000_000;
export const deliveryStatuses = ["queued", "submitting", "accepted", "deferred", "delivered", "bounced", "failed", "unknown", "canceled"] as const;
export const eventTypes = ["queued", "submitting", "accepted", "deferred", "delivered", "bounced", "failed", "opened", "clicked", "complained", "unsubscribed", "suppressed", "canceled", "unknown"] as const;
const contentSchema = z.string().refine(value => new TextEncoder().encode(value).byteLength <= MAX_CONTENT_BYTES, "Content must be at most 2000000 UTF-8 bytes");

export const createMessageSchema = z.object({
  category: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, "category must be a stable lowercase key")
    .default("transactional"),
  senderProfile: z.string().trim().min(1).max(120).optional(),
  to: z
    .array(
      z.object({
        email: z.string().email(),
        name: z.string().trim().min(1).max(100).optional(),
      }),
    )
    .min(1)
    .max(50),
  subject: z.string().trim().min(1).max(998),
  html: contentSchema.optional(),
  text: contentSchema.optional(),
  replyTo: z.string().email().optional(),
  tags: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), z.string().max(256))
    .refine(value => Object.keys(value).length <= 20, "tags must contain at most 20 entries")
    .optional(),
  referenceId: z.string().trim().min(1).max(160).optional(),
  metadata: z.record(z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/), z.string().max(500)).refine(value => Object.keys(value).length <= 20, "metadata must contain at most 20 entries").optional(),
}).strict().refine(input => Boolean(input.html || input.text), {
  message: "At least one of html or text is required",
  path: ["html"]
}).superRefine((input, context) => {
  const recipients = new Set<string>();
  input.to.forEach((recipient, index) => {
    const normalized = recipient.email.trim().toLowerCase();
    if (recipients.has(normalized)) context.addIssue({
      code: "custom",
      path: ["to", index, "email"],
      message: "Each recipient email can appear only once",
    });
    recipients.add(normalized);
  });
});

export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export const retryMessageSchema = z.object({
  acknowledgeDuplicateRisk: z.boolean().default(false),
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
  status: "queued";
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
  requestId?: string;
  errors?: Record<string, string[]>;
};

const iso = z.string().datetime({ offset: true });
const nullableText = z.string().nullable();
export const deliverySummarySchema = z.object({
  id: z.string(), messageId: z.string(), recipient: z.string(), recipientName: nullableText,
  subject: z.string(), category: z.string(), lifecycle: z.enum(deliveryStatuses),
  engagement: z.enum(["unopened", "opened", "clicked"]), compliance: z.enum(["clean", "complained", "unsubscribed", "suppressed"]),
  queuedAt: iso, updatedAt: iso,
});
export const publicEventSchema = z.object({
  id: z.string(), messageId: z.string(), deliveryId: z.string(), type: z.enum(eventTypes), occurredAt: iso,
  data: z.object({ attemptId: z.string().optional(), recipient: z.string().optional(), bounce: z.object({ classification: z.enum(["hard", "soft"]) }).optional() }),
});
export const attachmentSchema = z.object({ id: z.string(), fileName: z.string(), contentType: z.string(), size: z.number(), contentId: nullableText, scanStatus: z.enum(["clean", "skipped"]), contentAvailable: z.boolean().describe("Whether attachment bytes are retained; download also requires ready state and scan approval.") });
export const inboundSummarySchema = z.object({ id: z.string(), from: z.string(), to: z.array(z.string()), subject: z.string(), status: z.enum(["scanning", "ready", "rejected"]), attachmentCount: z.number(), receivedAt: iso });
export const inboundDetailSchema = inboundSummarySchema.omit({ attachmentCount: true }).extend({ cc: z.array(z.string()), bcc: z.array(z.string()), html: nullableText, text: nullableText, contentPurgedAt: iso.nullable().describe("UTC timestamp when message content was purged, or null while retained."), rejectionReason: nullableText, attachments: z.array(attachmentSchema) });
export const acceptedMessageSchema = z.object({ id: z.string(), status: z.literal("queued"), product: z.string(), category: z.string(), recipientCount: z.number(), acceptedAt: iso, referenceId: z.string().optional() });
export const messageSummarySchema = acceptedMessageSchema.extend({ status: z.enum(["in_progress", "delivered", "completed", "canceled"]), senderProfile: z.string(), subject: z.string(), referenceId: nullableText });
export const messageDetailSchema = messageSummarySchema.extend({ html: nullableText, text: nullableText, contentPurgedAt: iso.nullable().describe("UTC timestamp when message content was purged, or null while retained."), replyTo: nullableText, metadata: z.record(z.string(), z.string()), tags: z.record(z.string(), z.string()), deliveries: z.array(deliverySummarySchema.omit({ messageId: true, subject: true, category: true, queuedAt: true })) });
export const deliveryDetailSchema = deliverySummarySchema.extend({ referenceId: nullableText, acceptedAt: iso.nullable(), deliveredAt: iso.nullable(), attempts: z.array(z.object({ id: z.string(), number: z.number(), status: z.string(), outcomeDeterminate: z.boolean(), error: z.object({ category: z.string(), code: z.literal("submission_failed") }).nullable(), startedAt: iso, finishedAt: iso.nullable() })), events: z.array(publicEventSchema) });
export const suppressionSchema = z.object({ id: z.string(), scope: z.enum(["global", "product", "list"]), listId: nullableText, email: z.string(), reason: z.string(), source: z.string(), expiresAt: iso.nullable(), createdAt: iso });
export const senderSchema = z.object({ id: z.string(), name: z.string(), category: z.string(), from: z.object({ name: z.string(), email: z.string() }), replyTo: nullableText, availableProviders: z.number() });
export const problemDetailsSchema = z.object({ type: z.string(), title: z.string(), status: z.number(), detail: z.string(), requestId: z.string(), errors: z.record(z.string(), z.array(z.string())).optional() });
