/** Passive, versioned reading projection. Resource source URLs/private keys never cross this boundary. */
export type MailResourceState = "READY" | "PREPARING" | "RETRYABLE" | "BLOCKED" | "UNAVAILABLE" | "ERASED";
export type MailResourceReason = "NOT_READY" | "TRACKING_RISK" | "SOURCE_UNAVAILABLE" | "UNSUPPORTED_TYPE" | "SIZE_LIMIT" | "PIXEL_LIMIT" | "FETCH_FAILED" | "NETWORK_BLOCKED" | "SCAN_PENDING" | "SCAN_REJECTED" | "CONTENT_ERASED" | "RESOURCE_LIMIT";
export type MailDocumentResource = {
  id: string; kind: "CID" | "EMBEDDED" | "REMOTE"; contentId: string | null; attachmentId: string | null;
  contentType: string | null; size: number | null; state: MailResourceState; reasonCode: MailResourceReason | null; downloadEligible: boolean;
};
export type MailDocument = {
  revision: string; projectionVersion: 1; policyVersion: "mail-passive-v1"; sourceDigest: string | null;
  primaryRepresentation: "HTML" | "TEXT" | "NONE";
  textProvenance: "AUTHORED" | "DERIVED" | "NOT_RECORDED" | "UNAVAILABLE";
  state: "CURRENT" | "PARTIAL" | "SOURCE_UNAVAILABLE"; resources: MailDocumentResource[];
};
