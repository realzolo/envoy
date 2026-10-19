import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInboundService } from "@/modules/inbound/application/service";
import type { InboundDependencies, InboundRepository } from "@/modules/inbound/application/ports";
import type { InboundRoute } from "@/modules/inbound/contracts";

const route: InboundRoute = { id: "ir_test", product_id: "prd_test", service_id: "svc_test", recipients: ["support@example.test"] };
const now = new Date("2026-09-24T00:00:00.000Z");
const result = () => Promise.resolve({ rows: [], rowCount: 1 });
const repository: InboundRepository = {
  findRoutes: vi.fn(), freezeReceipt: vi.fn(result), readReceipt: vi.fn(), findTombstone: vi.fn(), insertRejected: vi.fn(),
  allowedDomains: vi.fn(), findCopy: vi.fn(), insertCopy: vi.fn(result), findConcurrentCopy: vi.fn(), recordDates: vi.fn(result),
  claimCopy: vi.fn(), copyState: vi.fn(), renewClaim: vi.fn(result), authorizeCompletion: vi.fn(result), completeCopy: vi.fn(),
  insertAttachment: vi.fn(result), subscribedCallbacks: vi.fn(), insertCallback: vi.fn(result), enqueueCallback: vi.fn(result),
  rejectCopy: vi.fn(result), releaseClaim: vi.fn(result), registerAttachment: vi.fn(), completeUploads: vi.fn(),
};
const uploads = { register: vi.fn(), put: vi.fn() };
const dependencies: InboundDependencies = {
  repository, unitOfWork: { run: work => work(repository) }, id: prefix => `${prefix}_test`, digest: () => "digest",
  sanitizeHtml: html => html, uploads,
};
const { persistInbound } = createInboundService(dependencies);
const message = {
  externalMessageId: "external-test", from: "sender@example.test", to: ["support@example.test"], envelopeRecipients: ["support@example.test"],
  cc: [], bcc: [], subject: "Inbound test", rawMime: Buffer.from([1, 2, 3]), attachments: [], receivedAt: now,
};
const input = () => ({ providerAccountId: "pa_test", webhookEndpointId: "pwe_test", rawEventId: "raw_test", message });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(repository.findRoutes).mockResolvedValue({ rows: [route], rowCount: 1 });
  vi.mocked(repository.readReceipt).mockResolvedValue({ rows: [{ routes: [route], terminated_at: null, ingress_received_at: now }], rowCount: 1 });
  vi.mocked(repository.allowedDomains).mockResolvedValue({ rows: [{ domain: "example.test" }], rowCount: 1 });
  vi.mocked(repository.findCopy).mockResolvedValue({ rows: [], rowCount: 0 });
  vi.mocked(repository.claimCopy).mockResolvedValue({ rows: [{ received_at: now }], rowCount: 1 });
  vi.mocked(repository.completeCopy).mockResolvedValue({ rows: [{ id: "inb_test", ready_at: now }], rowCount: 1 });
  vi.mocked(repository.subscribedCallbacks).mockResolvedValue({ rows: [], rowCount: 0 });
  uploads.put.mockResolvedValue(undefined);
});

describe("inbound application without a database", () => {
  it("keeps scanning retryable after storage failure and completes the retry", async () => {
    uploads.put.mockRejectedValueOnce(new Error("S3 temporarily unavailable"));
    await expect(persistInbound(input())).rejects.toThrow("S3 temporarily unavailable");
    expect(repository.rejectCopy).not.toHaveBeenCalled();
    expect(repository.releaseClaim).toHaveBeenCalled();
    await expect(persistInbound(input())).resolves.toBe("inb_test");
    expect(uploads.put).toHaveBeenCalledTimes(2);
    expect(repository.completeUploads).toHaveBeenCalledWith(["inbound/inb_test/claim_test/raw.eml"]);
  });
  it("rejects message-size violations before storing bytes", async () => {
    await expect(persistInbound({ ...input(), message: { ...message, rawMime: { byteLength: 25 * 1024 * 1024 + 1 } as Buffer } })).resolves.toBe("inb_test");
    expect(repository.rejectCopy).toHaveBeenCalledWith(expect.objectContaining({ reason: "INBOUND_MESSAGE_TOO_LARGE" }));
    expect(uploads.put).not.toHaveBeenCalled();
  });
  it("quarantines receipts with no eligible routes", async () => {
    vi.mocked(repository.findRoutes).mockResolvedValue({ rows: [], rowCount: 0 });
    vi.mocked(repository.readReceipt).mockResolvedValue({ rows: [{ routes: [], terminated_at: null, ingress_received_at: now }], rowCount: 1 });
    vi.mocked(repository.findTombstone).mockResolvedValue({ rows: [], rowCount: 0 });
    vi.mocked(repository.insertRejected).mockResolvedValue({ rows: [{ id: "inb_test" }], rowCount: 1 });
    await expect(persistInbound(input())).resolves.toBe("inb_test");
    expect(repository.insertRejected).toHaveBeenCalledWith(expect.objectContaining({ reason: "NO_INBOUND_ROUTE" }));
    expect(uploads.put).not.toHaveBeenCalled();
  });
});
