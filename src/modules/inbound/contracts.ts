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


export type { MailResourceState as InboundResourceState, MailResourceReason as InboundResourceReason, MailDocumentResource as InboundDocumentResource, MailDocument as InboundDocument } from "@/lib/mail-document-contracts";

export { inboundDocumentSchema, inboundDocumentResourceSchema } from "./domain/document-wire";
