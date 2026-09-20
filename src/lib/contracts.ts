import { z } from "zod";

export const createMessageSchema = z.object({
  template: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, "template must be a stable lowercase key"),
  to: z
    .array(
      z.object({
        email: z.string().email(),
        name: z.string().trim().min(1).max(100).optional(),
      }),
    )
    .min(1)
    .max(50),
  locale: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).default("en-US"),
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  referenceId: z.string().trim().min(1).max(160).optional(),
  metadata: z.record(z.string(), z.string().max(500)).optional(),
}).strict();

export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export type AcceptedMessage = {
  id: string;
  status: "queued";
  product: string;
  template: string;
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
