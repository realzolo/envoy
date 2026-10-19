import type { CanonicalInboundMessage } from "@/integrations/providers/contracts";
export type InboundInput = {
  providerAccountId: string;
  webhookEndpointId: string;
  rawEventId: string;
  message: CanonicalInboundMessage;
  ingressReceivedAt?: Date;
};
export type InboundDispatch = {
  service_id: string;
  recipients: string[];
};

