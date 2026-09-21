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
  recipient: string;
  recipientName?: string;
  subject: string;
  category: string;
  product: string;
  from: string;
  status: DeliveryStatus;
  createdAt: string;
  relativeTime: string;
  providerId?: string;
  referenceId?: string;
};

export type DomainRecord = {
  id: string;
  name: string;
  product: string;
  sender: string;
  region: string;
  status: "verified" | "pending" | "failed";
  volume: string;
};
