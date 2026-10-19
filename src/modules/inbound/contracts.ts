import type { CanonicalInboundMessage } from "@/integrations/providers/contracts";
export type InboundInput = {
  providerAccountId: string;
  webhookEndpointId: string;
  rawEventId: string;
  message: CanonicalInboundMessage;
  ingressReceivedAt?: Date;
};
export type InboundRoute = {
  id: string; product_id: string; service_id: string;
  recipients: string[];
};

