export type DeliveryStatus =
  | "delivered"
  | "accepted"
  | "submitting"
  | "queued"
  | "deferred"
  | "unknown"
  | "bounced"
  | "failed"
  | "suppressed";

export type EmailRecord = {
  id: string;
  recipient: string;
  recipientName?: string;
  subject: string;
  template: string;
  product: string;
  from: string;
  status: DeliveryStatus;
  createdAt: string;
  relativeTime: string;
  providerId?: string;
  referenceId?: string;
};

export type TemplateRecord = {
  id: string;
  key: string;
  name: string;
  description: string;
  subject: string;
  product: string;
  version: number;
  updatedAt: string;
  accent: "blue" | "green" | "violet" | "amber";
  variables: string[];
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
