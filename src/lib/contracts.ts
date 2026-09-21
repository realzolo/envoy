import { z } from "zod";

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
  html: z.string().max(2_000_000).optional(),
  text: z.string().max(2_000_000).optional(),
  replyTo: z.string().email().optional(),
  tags: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), z.string().max(256))
    .refine(value => Object.keys(value).length <= 20, "tags must contain at most 20 entries")
    .optional(),
  referenceId: z.string().trim().min(1).max(160).optional(),
  metadata: z.record(z.string(), z.string().max(500)).optional(),
}).strict().refine(input => Boolean(input.html || input.text), {
  message: "At least one of html or text is required",
  path: ["html"]
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
  errors?: Record<string, string[]>;
};
