import type { PoolClient } from "pg";
import { scanPolicy } from "./scanner";

export type SafetyRow = {
  status: string; expected_sha256: string; scanned_sha256: string | null; policy_version: string | null;
  attempt_count: number; reason: string | null;
};
export class AttachmentUseError extends Error {
  constructor(public code: "FILE_NOT_READY" | "FILE_UNAVAILABLE", public reasonCode: string) { super(reasonCode); }
}
export function attachmentUsage(retained: boolean, sha256: string | null, safety?: SafetyRow | null, direction: "outbound" | "inbound" = "outbound") {
  const policy = scanPolicy();
  const current = safety?.policy_version === policy.version;
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
export function assertUsable(retained: boolean, sha256: string | null, safety?: SafetyRow | null) {
  const usage = attachmentUsage(retained, sha256, safety);
  if (!usage.canSend) throw new AttachmentUseError(usage.processing ? "FILE_NOT_READY" : "FILE_UNAVAILABLE", usage.reasonCode!);
}
export async function registerAttachment(client: PoolClient, id: string, kind: "outbound" | "inbound", serviceId: string | null, sha256: string) {
  const scope = serviceId ?? "administrator";
  await client.query("INSERT INTO attachment_scan_scopes(scope) VALUES($1) ON CONFLICT DO NOTHING",[scope]);
  await client.query(`INSERT INTO attachment_safety(resource_id,kind,service_id,scope,expected_sha256) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[id,kind,serviceId,scope,sha256]);
}
