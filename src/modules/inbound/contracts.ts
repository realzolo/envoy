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


/** Passive, versioned reading projection. Resource source URLs/private keys never cross this boundary. */
export type InboundResourceState = "READY" | "PREPARING" | "RETRYABLE" | "BLOCKED" | "UNAVAILABLE" | "ERASED";
export type InboundResourceReason = "NOT_READY" | "TRACKING_RISK" | "SOURCE_UNAVAILABLE" | "UNSUPPORTED_TYPE" | "SIZE_LIMIT" | "PIXEL_LIMIT" | "FETCH_FAILED" | "NETWORK_BLOCKED" | "SCAN_PENDING" | "SCAN_REJECTED" | "CONTENT_ERASED" | "RESOURCE_LIMIT";
export type InboundDocumentResource = {
  id: string; kind: "CID" | "EMBEDDED" | "REMOTE"; contentId: string | null; attachmentId: string | null;
  contentType: string | null; size: number | null; state: InboundResourceState; reasonCode: InboundResourceReason | null; downloadEligible: boolean;
};
export type InboundDocument = {
  revision: string; projectionVersion: 1; policyVersion: "mail-passive-v1"; sourceDigest: string | null;
  primaryRepresentation: "HTML" | "TEXT" | "NONE";
  textProvenance: "AUTHORED" | "DERIVED" | "NOT_RECORDED" | "UNAVAILABLE";
  state: "CURRENT" | "PARTIAL" | "SOURCE_UNAVAILABLE"; resources: InboundDocumentResource[];
};

export { inboundDocumentSchema, inboundDocumentResourceSchema } from "./domain/document-wire";
