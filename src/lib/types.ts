export type DeliveryStatus =
  | "delivered"
  | "accepted"
  | "submitting"
  | "queued"
  | "deferred"
  | "unknown"
  | "bounced"
  | "failed"
  | "canceled"
  | "suppressed";

export type EmailRecord = {
  id: string;
  messageId?: string;
  recipient: string;
  recipientName?: string;
  recipientRole?: "to" | "cc" | "bcc";
  lastError?: Record<string, unknown> | null;
  subject: string;
  category: string;
  service: string;
  from: string;
  status: DeliveryStatus;
  createdAt: string;
  relativeTime: string;
  providerId?: string;
  referenceId?: string;
};
