import { beforeEach, describe, expect, it, vi } from "vitest";
import { query, transaction } from "@/server/database";
import { getOutboundFile, resolveOutboundAttachments, uploadOutboundFile } from "@/modules/files/service";
import { objectStore } from "@/modules/config/object-store";
vi.mock("@/server/database", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("@/modules/config/object-store", () => ({ objectStore: vi.fn() }));
const row = { id: "file_1", service_id: "svc_1", file_name: "receipt.pdf", content_type: "application/pdf", size_bytes: "128", sha256: "digest", object_key: "private/object", content_purged_at: null, created_at: new Date("2026-10-17T00:00:00Z") };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never); });

describe("service-owned outbound files", () => {
  it("resolves immutable file metadata within the acceptance transaction", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [row] }) };
    const snapshots = await resolveOutboundAttachments("svc_1", [{ fileId: "file_1", disposition: "attachment" }], client as never);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("FOR SHARE"), [["file_1"], "svc_1"]);
    expect(client.query.mock.calls[0][0]).toContain("content_purged_at IS NULL");
    expect(snapshots).toEqual([{ fileId: "file_1", fileName: "receipt.pdf", contentType: "application/pdf", size: 128, sha256: "digest", objectKey: "private/object", disposition: "attachment", contentId: null }]);
  });
  it("rejects unavailable, purged or foreign files without leaking their ownership", async () => {
    await expect(resolveOutboundAttachments("svc_other", [{ fileId: "file_1", disposition: "attachment" }])).rejects.toThrow("unavailable or is not owned");
    expect(vi.mocked(query).mock.calls[0][1]).toEqual([["file_1"], "svc_other"]);
  });
  it("enforces the aggregate attachment budget even when a file is used more than once", async () => {
    vi.mocked(query).mockResolvedValue({ rows: [{ ...row, size_bytes: "10000000" }] } as never);
    await expect(resolveOutboundAttachments("svc_1", Array.from({ length: 3 }, () => ({ fileId: "file_1", disposition: "attachment" as const })))).rejects.toThrow("20000000");
  });
  it("returns public metadata without object keys or service identifiers", async () => {
    vi.mocked(query).mockResolvedValue({ rows: [row] } as never);
    const result = await getOutboundFile("file_1", "svc_1");
    expect(result).toMatchObject({ fileName: "receipt.pdf", contentAvailable: true, size: 128 });
    expect(JSON.stringify(result)).not.toMatch(/private\/object|svc_1/);
    expect(vi.mocked(query).mock.calls[0][1]).toEqual(["file_1", "svc_1"]);
  });
  it.each(["../secret", "a/b.pdf", "a\\b.pdf", "a\nInjected"])("rejects unsafe upload filename %s before storage", async fileName => {
    await expect(uploadOutboundFile("svc_1", fileName, "application/pdf", new Uint8Array([1]))).rejects.toThrow("plain file name");
    expect(query).not.toHaveBeenCalled();
    expect(objectStore).not.toHaveBeenCalled();
  });
  it("retains cleanup intent on uncertain upload commit instead of deleting referenced bytes", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn();
    vi.mocked(objectStore).mockReturnValue({ put, delete: remove, get: vi.fn() });
    vi.mocked(transaction).mockRejectedValue(new Error("commit response lost"));
    await expect(uploadOutboundFile("svc_1", "invoice.pdf", "application/pdf", new Uint8Array([1,2,3]))).rejects.toThrow("commit response lost");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("pending_object_deletions"), [expect.stringContaining("outbound/svc_1/file_")]);
    expect(put).toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
