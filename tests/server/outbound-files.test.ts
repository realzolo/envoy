import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFilesService } from "@/modules/attachments/application/files";
import type { AttachmentDependencies, AttachmentRepositories, FilesRepository } from "@/modules/attachments/application/ports";
import { attachmentUsage, assertUsable } from "@/modules/attachments/domain/safety";
import type { FileRow } from "@/modules/attachments/contracts";

const safety = { resource_id: "file_1", status: "clean", expected_sha256: "digest", scanned_sha256: "digest", policy_version: "1", attempt_count: 1, reason: null };
const row: FileRow = { safety, id: "file_1", service_id: "svc_1", sending_domain_id: "domain_1", file_name: "receipt.pdf", content_type: "application/pdf", size_bytes: "128", sha256: "digest", object_key: "private/object", content_purged_at: null, created_at: new Date("2026-10-17T00:00:00Z") };
const files: FilesRepository = {
  insertFile: vi.fn(), findAuthorizedFile: vi.fn(), listLockedFiles: vi.fn(), listFiles: vi.fn(), listLockedSafety: vi.fn(),
};
const graph = {
  files,
  authorizedSendingDomain: vi.fn().mockResolvedValue("domain_1"),
  completeObjectUploads: vi.fn(), registerAttachment: vi.fn(),
} as unknown as AttachmentRepositories;
const put = vi.fn(), remove = vi.fn();
const registerObjectUpload = vi.fn(), authorizedSendingDomain = vi.fn();
const run = vi.fn((work: (repositories: AttachmentRepositories) => Promise<unknown>) => work(graph));
// Deliberately supply only the capabilities used by this application service.
// A database, SQL executor and object-store implementation are never constructed.
const dependencies = {
  repositories: graph, unitOfWork: { run }, authorizedSendingDomain, registerObjectUpload,
  objectStore: { put, delete: remove },
  attachmentUsage: (...args: Parameters<AttachmentDependencies["attachmentUsage"]>) => attachmentUsage("1", ...args),
  assertUsable: (...args: Parameters<AttachmentDependencies["assertUsable"]>) => assertUsable("1", ...args),
} as unknown as AttachmentDependencies;
const { getOutboundFile, resolveOutboundAttachments, uploadOutboundFile } = createFilesService(dependencies);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(files.listFiles).mockResolvedValue({ rows: [], rowCount: 0 });
  vi.mocked(files.listLockedFiles).mockResolvedValue({ rows: [row], rowCount: 1 });
  vi.mocked(files.listLockedSafety).mockResolvedValue({ rows: [safety], rowCount: 1 });
  vi.mocked(files.findAuthorizedFile).mockResolvedValue({ rows: [row], rowCount: 1 });
  authorizedSendingDomain.mockResolvedValue("domain_1");
  run.mockImplementation(work => work(graph));
});

describe("outbound attachment application without a database", () => {
  it("resolves immutable metadata and safety through the acceptance transaction repositories", async () => {
    const snapshots = await resolveOutboundAttachments("svc_1", [{ fileId: "file_1", disposition: "attachment" }], graph);
    expect(files.listLockedFiles).toHaveBeenCalledWith({ fileIds: ["file_1"], serviceId: "svc_1" });
    expect(files.listLockedSafety).toHaveBeenCalledWith({ resourceIds: ["file_1"] });
    expect(snapshots).toEqual([{ fileId: "file_1", fileName: "receipt.pdf", contentType: "application/pdf", size: 128, sha256: "digest", objectKey: "private/object", disposition: "attachment", contentId: null }]);
  });
  it("rejects unavailable or foreign files without exposing their owner", async () => {
    await expect(resolveOutboundAttachments("svc_other", [{ fileId: "file_1", disposition: "attachment" }])).rejects.toMatchObject({ code: "FILE_UNAVAILABLE" });
    expect(files.listFiles).toHaveBeenCalledWith({ fileIds: ["file_1"], serviceId: "svc_other" });
  });
  it("enforces the aggregate attachment budget when a file is used more than once", async () => {
    vi.mocked(files.listFiles).mockResolvedValue({ rows: [{ ...row, size_bytes: "10000000" }], rowCount: 1 });
    await expect(resolveOutboundAttachments("svc_1", Array.from({ length: 3 }, () => ({ fileId: "file_1", disposition: "attachment" as const })))).rejects.toThrow("20000000");
  });
  it("returns an explicit public DTO without object keys or service identifiers", async () => {
    const result = await getOutboundFile("file_1", "svc_1");
    expect(result).toMatchObject({ fileName: "receipt.pdf", contentAvailable: true, size: 128 });
    expect(JSON.stringify(result)).not.toMatch(/private\/object|svc_1/);
  });
  it.each(["../secret", "a/b.pdf", "a\\b.pdf", "a\nInjected"])("rejects unsafe upload filename %s before storage", async fileName => {
    await expect(uploadOutboundFile("svc_1", fileName, "application/pdf", new Uint8Array([1]), "mail.example.test")).rejects.toThrow("plain file name");
    expect(put).not.toHaveBeenCalled();
    expect(authorizedSendingDomain).not.toHaveBeenCalled();
  });
  it("keeps cleanup intent on uncertain commit instead of deleting possibly committed bytes", async () => {
    run.mockRejectedValueOnce(new Error("commit response lost"));
    await expect(uploadOutboundFile("svc_1", "invoice.pdf", "application/pdf", new Uint8Array([1, 2, 3]), "mail.example.test")).rejects.toThrow("commit response lost");
    expect(registerObjectUpload).toHaveBeenCalledWith(expect.stringContaining("outbound/svc_1/file_"));
    expect(put).toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
