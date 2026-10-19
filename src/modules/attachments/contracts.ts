export type AttachmentSnapshot = { fileId: string; fileName: string; contentType: string; size: number; sha256: string; objectKey: string; disposition: "attachment" | "inline"; contentId: string | null };
export type FileRow = { id: string; service_id: string; sending_domain_id:string; file_name: string; content_type: string; size_bytes: string; sha256: string; object_key: string; content_purged_at: Date | null; created_at: Date; safety: SafetyRow | null };
export type Task = { resource_id: string; kind: "outbound" | "inbound"; service_id: string | null; expected_sha256: string; attempt_count: number; lease_token: string };
export type SafetyRow = {
  status: string; expected_sha256: string; scanned_sha256: string | null; policy_version: string | null;
  attempt_count: number; reason: string | null;
};

export class FileValidationError extends Error {}
