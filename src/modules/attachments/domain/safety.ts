import type { SafetyRow } from "../contracts";
export class AttachmentUseError extends Error {
  constructor(public code: "FILE_NOT_READY" | "FILE_UNAVAILABLE", public reasonCode: string) { super(reasonCode); }
}
export function attachmentUsage(policyVersion: string, retained: boolean, sha256: string | null, safety?: SafetyRow | null, direction: "outbound" | "inbound" = "outbound", mode: "require_clean" | "integrity_only" = "require_clean") {
  const current = safety?.policy_version === policyVersion;
  const approved = current && safety?.status === (mode === "integrity_only" ? "verified" : "clean") && Boolean(sha256) && sha256 === safety.scanned_sha256 && sha256 === safety.expected_sha256;
  const terminal = safety?.status === "malicious" || safety?.status === "blocked";
  const processing = retained && !terminal && !approved && (!safety || safety.attempt_count < 5 || !current);
  const reasonCode = !retained ? "FILE_CONTENT_PURGED" : safety?.status === "malicious" ? "FILE_MALICIOUS"
    : safety?.status === "blocked" ? safety.reason ?? "FILE_INTEGRITY_FAILED"
    : approved ? null : !current ? mode === "require_clean" ? "FILE_SCAN_REQUIRED" : "FILE_VERIFICATION_REQUIRED"
    : safety?.reason ?? (mode === "require_clean" ? "FILE_SCAN_PENDING" : "FILE_VERIFICATION_PENDING");
  return { state: !retained || terminal ? "unavailable" as const : approved ? "usable" as const : processing ? "processing" as const : "unavailable" as const,
    safetyState: !retained ? "purged" : terminal ? safety!.status : !current ? "unscanned" : safety?.status ?? "unscanned",
    processing, canSend: retained && approved && direction === "outbound", canDownload: retained && approved,
    reasonCode, retryable: processing, recovery: processing ? "poll" as const : retained && !terminal && !approved ? "retry" as const : "none" as const };
}
export function assertUsable(policyVersion: string, retained: boolean, sha256: string | null, safety?: SafetyRow | null, mode: "require_clean" | "integrity_only" = "require_clean") {
  const usage = attachmentUsage(policyVersion, retained, sha256, safety, "outbound", mode);
  if (!usage.canSend) throw new AttachmentUseError(usage.processing ? "FILE_NOT_READY" : "FILE_UNAVAILABLE", usage.reasonCode!);
}

export type AttachmentUsage = ReturnType<typeof attachmentUsage>;
