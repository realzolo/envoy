import type { SafetyRow } from "../contracts";
export class AttachmentUseError extends Error {
  constructor(public code: "FILE_NOT_READY" | "FILE_UNAVAILABLE", public reasonCode: string) { super(reasonCode); }
}
export function attachmentUsage(policyVersion: string, retained: boolean, sha256: string | null, safety?: SafetyRow | null, direction: "outbound" | "inbound" = "outbound") {
  const current = safety?.policy_version === policyVersion;
  const clean = current && safety?.status === "clean" && Boolean(sha256) && sha256 === safety.scanned_sha256 && sha256 === safety.expected_sha256;
  const terminal = safety?.status === "malicious" || safety?.status === "blocked";
  const processing = retained && !terminal && !clean && (!safety || safety.attempt_count < 5 || !current);
  const reasonCode = !retained ? "FILE_CONTENT_PURGED" : safety?.status === "malicious" ? "FILE_MALICIOUS"
    : safety?.status === "blocked" ? safety.reason ?? "FILE_INTEGRITY_FAILED"
    : clean ? null : !current ? "FILE_SCAN_REQUIRED" : safety?.reason ?? "FILE_SCAN_PENDING";
  return { state: !retained || terminal ? "unavailable" as const : clean ? "usable" as const : processing ? "processing" as const : "unavailable" as const,
    safetyState: !retained ? "purged" : terminal ? safety!.status : !current ? "unscanned" : safety?.status ?? "unscanned",
    processing, canSend: retained && clean && direction === "outbound", canDownload: retained && clean,
    reasonCode, retryable: processing, recovery: processing ? "poll" as const : retained && !terminal && !clean ? "retry" as const : "none" as const };
}
export function assertUsable(policyVersion: string, retained: boolean, sha256: string | null, safety?: SafetyRow | null) {
  const usage = attachmentUsage(policyVersion, retained, sha256, safety);
  if (!usage.canSend) throw new AttachmentUseError(usage.processing ? "FILE_NOT_READY" : "FILE_UNAVAILABLE", usage.reasonCode!);
}

export type AttachmentUsage = ReturnType<typeof attachmentUsage>;
