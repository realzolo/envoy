export { uploadOutboundFile, getOutboundFile, resolveOutboundAttachments, registerAttachment, scheduleAttachmentScans, processAttachmentScan, retryAttachmentScan, withSafeOutboundAttachments, attachmentUsage, assertUsable } from "./infrastructure/services";
export { AttachmentUseError } from "./domain/safety";
export { FileValidationError } from "./contracts";
export type { AttachmentSnapshot, SafetyRow } from "./contracts";
export { scanPolicy, scanBytes } from "./infrastructure/scanner";
export { digest } from "./domain/digest";
export { attachmentAdminReads } from "./infrastructure/admin.read-repository";

export { downloadAttachment } from "./http/download";
