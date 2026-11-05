import { z } from "zod";
export const inboundDocumentResourceSchema=z.object({
  id:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),kind:z.enum(["CID","EMBEDDED","REMOTE"]),contentId:z.string().max(998).nullable(),attachmentId:z.string().max(200).nullable(),
  contentType:z.enum(["image/png","image/jpeg","image/gif","image/webp"]).nullable(),size:z.number().int().min(0).max(5_000_000).nullable(),
  state:z.enum(["READY","PREPARING","RETRYABLE","BLOCKED","UNAVAILABLE","ERASED"]),
  reasonCode:z.enum(["NOT_READY","TRACKING_RISK","SOURCE_UNAVAILABLE","UNSUPPORTED_TYPE","SIZE_LIMIT","PIXEL_LIMIT","FETCH_FAILED","NETWORK_BLOCKED","SCAN_PENDING","SCAN_REJECTED","CONTENT_ERASED","RESOURCE_LIMIT"]).nullable(),downloadEligible:z.boolean(),
});
export const inboundDocumentSchema=z.object({revision:z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/),projectionVersion:z.literal(1),policyVersion:z.literal("mail-passive-v1"),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable(),primaryRepresentation:z.enum(["HTML","TEXT","NONE"]),textProvenance:z.enum(["AUTHORED","DERIVED","NOT_RECORDED","UNAVAILABLE"]),state:z.enum(["CURRENT","PARTIAL","SOURCE_UNAVAILABLE"]),resources:z.array(inboundDocumentResourceSchema).max(64)});
