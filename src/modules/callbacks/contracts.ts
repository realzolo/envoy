import { z } from "zod";

export const callbackInputSchema = z.object({
  serviceId: z.string().trim().min(1).max(160), name: z.string().trim().min(2).max(120),
  url: z.string().trim().url().max(2048),
  events: z.array(z.enum(["email.accepted", "email.delivered", "email.bounced", "email.failed", "email.suppressed", "inbound.received", "service.permissions_changed"])).min(1).max(7),
}).strict();
export type CallbackInput = { serviceId: string; name: string; url: string; events: string[] };
export type CallbackSecret = { secretCiphertext: string; encryptedDek: string; keyVersion: string };
export type CallbackClaim = CallbackSecret & {
  id: string; endpointId: string; url: string; eligible: boolean;
  payload: Record<string, unknown>; attempt: number;
};
