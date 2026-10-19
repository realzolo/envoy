import { createDeliveryWorkflow } from "@/modules/outbound/application/delivery";
import { createReconciliationWorkflow } from "@/modules/outbound/application/reconciliation";
import type { DeliverySubmission } from "@/modules/outbound/contracts";
import { SendPreparationError } from "@/modules/outbound/domain/submission-error";
import { describe, expect, it, vi } from "vitest";
function dependencies() {
    const submission: DeliverySubmission = {
        attemptId: "att_1", attemptNumber: 1, submissionId: "sub_1", messageId: "msg_1",
        providerAccountId: "account_1", providerIdentityId: "identity_1", providerType: "resend", providerName: "provider",
        providerIdempotencyKey: "stable-key", requestFingerprint: "hash", routingSnapshot: {}, attachments: [], sendBefore: null, sensitive: false,
        message: { submissionId: "sub_1", from: { email: "from@example.com" }, to: [{ email: "to@example.com" }], cc: [], bcc: [], replyTo: [], subject: "test", text: "body", headers: {}, references: [], attachments: [], tags: {} },
    };
    return {
        prepareSubmission: vi.fn(async () => submission),
        markAccepted: vi.fn(async () => { }), markUnknown: vi.fn(async () => { }),
        markDeterminateFailure: vi.fn(async () => null), applyCanonicalEvent: vi.fn(async () => true),
        sender: { send: vi.fn(async () => ({ outcome: "accepted" as const, externalMessageId: "external_1", response: {} })) },
    };
}
describe("outbound submission workflow", () => {
    it("records uncertainty without authorizing automatic failover", async () => {
        const deps = dependencies();
        deps.sender.send.mockRejectedValue(new Error("connection lost after sending request"));
        await createDeliveryWorkflow(deps)("sub_1");
        expect(deps.markUnknown).toHaveBeenCalledOnce();
        expect(deps.markDeterminateFailure).not.toHaveBeenCalled();
        expect(deps.prepareSubmission).toHaveBeenCalledOnce();
    });
    it("treats rejected local preparation as a determinate non-retryable failure", async () => {
        const deps = dependencies();
        deps.sender.send.mockRejectedValue(new SendPreparationError("ATTACHMENT_REVOKED", "not authorized"));
        await createDeliveryWorkflow(deps)("sub_1");
        expect(deps.markDeterminateFailure).toHaveBeenCalledWith("att_1", expect.objectContaining({ code: "ATTACHMENT_REVOKED" }), false);
        expect(deps.markUnknown).not.toHaveBeenCalled();
    });
    it("does not convert persistence failure after provider acceptance into failover", async () => {
        const deps = dependencies();
        deps.markAccepted.mockRejectedValue(new Error("database connection lost"));
        await expect(createDeliveryWorkflow(deps)("sub_1")).rejects.toThrow("database connection lost");
        expect(deps.markDeterminateFailure).not.toHaveBeenCalled();
        expect(deps.markUnknown).not.toHaveBeenCalled();
    });
});
describe("provider reconciliation workflow", () => {
    it("keeps acceptance unknown when reconciliation fails", async () => {
        const deps = {
            getAttemptForReconciliation: vi.fn(async () => ({ id: "att_1", submission_id: "sub_1", provider_account_id: "account_1", external_message_id: null, request_fingerprint: "hash", status: "unknown" })),
            markReconciled: vi.fn(async () => { }), reconciler: { reconcile: vi.fn(async (): Promise<"unknown"> => { throw new Error("unavailable"); }) },
        };
        await createReconciliationWorkflow(deps)("att_1");
        expect(deps.markReconciled).toHaveBeenCalledWith("att_1", "unknown");
    });
});
