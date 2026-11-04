import type { ZodError } from "zod";
import type { MailDiagnostic } from "@/contracts/mail-diagnostics";

/** Classification depends only on typed issue facts; input and issue prose are never copied. */
export function validationDiagnostic(error: ZodError): MailDiagnostic {
  const invalidRecipient = error.issues.some(issue => issue.code === "invalid_format" && issue.format === "email"
    && issue.path.length === 3 && typeof issue.path[0] === "string" && ["to", "cc", "bcc"].includes(issue.path[0])
    && typeof issue.path[1] === "number" && Number.isInteger(issue.path[1]) && issue.path[1] >= 0 && issue.path[2] === "email");
  return {source:"ENVOY",code:invalidRecipient?"INVALID_RECIPIENT":"VALIDATION_FAILED",reasonCode:invalidRecipient?"INVALID_RECIPIENT":null,
    stage:"PREPARATION",detailAvailability:invalidRecipient?"SPECIFIC":"CATEGORY_ONLY",evidence:{},occurredAt:new Date().toISOString()};
}
