import { describe, expect, it } from "vitest";
import { diagnosticCodes, diagnosticReasons, stoppedRetry, type DeliverySnapshot, type MailDiagnostic } from "@/contracts/mail-diagnostics";
import { deliveryPresentation, diagnosticPresentation } from "@/features/outbound/diagnostic-presentation";
import type { DeliveryStatus } from "@/lib/types";

const delivered: DeliverySnapshot = {
  id: "delivery", messageId: "message", revision: "1", submissionId: "submission", attemptId: "attempt",
  lifecycle: "delivered", outcome: "succeeded", acceptedAt: "2026-11-04T00:00:00Z", deliveredAt: "2026-11-04T00:01:00Z",
  diagnostic: null, retryDisposition: stoppedRetry, observedAt: "2026-11-04T00:02:00Z",
};
const diagnostic: MailDiagnostic = {
  source: "PROVIDER", code: "MAILBOX_PERMANENTLY_REJECTED", reasonCode: null,
  stage: "RECIPIENT_DELIVERY", detailAvailability: "PROVIDER_NOT_SUPPLIED", evidence: {}, occurredAt: null,
};

describe("administrative delivery presentation", () => {
  it("presents completed delivery as success even though processing has stopped", () => {
    expect(deliveryPresentation({ status: "delivered", diagnostic: null, transport: delivered })).toEqual({
      title: "Delivered successfully", followUp: "No action needed",
    });
    expect(deliveryPresentation({ status: "delivered" })).toEqual({
      title: "Delivered successfully", followUp: "No action needed",
    });
  });

  it.each<DeliveryStatus>(["queued", "submitting", "accepted", "deferred"])("does not invent a failure for %s without a diagnostic", (status) => {
    const presentation = deliveryPresentation({ status, diagnostic: null });
    expect(`${presentation.title} ${presentation.followUp}`).not.toMatch(/fail|not recorded|stopped/i);
  });

  it("separates provider processing responsibility from the delivery outcome", () => {
    const transport: DeliverySnapshot = {
      ...delivered, lifecycle: "accepted", outcome: "pending", deliveredAt: null,
      retryDisposition: { owner: "PROVIDER", action: "WAITING_PROVIDER", nextAttemptAt: null },
    };
    expect(deliveryPresentation({ status: "accepted", transport })).toMatchObject({
      title: "Provider accepted the message", followUp: "The provider is processing delivery; wait for the final result.",
    });
    expect(deliveryPresentation({ status: "unknown" }).title).toBe("Delivery outcome is not confirmed");
  });

  it.each<DeliveryStatus>(["failed", "bounced"])("reports absent failure detail only for a failed outcome (%s)", (status) => {
    expect(deliveryPresentation({ status, diagnostic: null }).followUp).toMatch(/information was not recorded/);
  });

  it("retains an evidenced diagnostic and its advice after processing ends", () => {
    const specific: MailDiagnostic = { ...diagnostic, reasonCode: "MAILBOX_NOT_FOUND", detailAvailability: "SPECIFIC" };
    expect(deliveryPresentation({ status: "bounced", diagnostic: specific, transport: { ...delivered, lifecycle: "bounced", outcome: "failed", diagnostic: specific } })).toEqual({
      title: "Recipient mailbox does not exist",
      followUp: "Verify the recipient address before starting a new send through your application.",
    });
  });

  it("keeps all canonical diagnostic and detail explanations in English", () => {
    const explanations = [
      ...diagnosticCodes.map((code) => diagnosticPresentation({ ...diagnostic, code })),
      ...diagnosticReasons.map((reasonCode) => diagnosticPresentation({ ...diagnostic, reasonCode, detailAvailability: "SPECIFIC" })),
      ...(["CATEGORY_ONLY", "NOT_RECORDED"] as const).map((detailAvailability) => diagnosticPresentation({ ...diagnostic, detailAvailability })),
    ];
    for (const explanation of explanations) {
      for (const text of Object.values(explanation)) {
        expect(text.trim().length).toBeGreaterThan(0);
        expect(text).not.toMatch(/\p{Script=Han}/u);
      }
    }
  });
});
