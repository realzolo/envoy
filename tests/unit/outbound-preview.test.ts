import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOutboundPreviewService, type PreviewDependencies, type PreviewRecord } from "@/modules/outbound/application/preview";
import { renderMailPreview, MAIL_PREVIEW_CSP } from "@/lib/mail-preview";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fixture = (): PreviewRecord => ({ messageId: "msg_a", serviceId: "svc_a", html: '<img src="cid:logo%40app" alt="App logo">',
  attachments: [{fileId:"file_logo",contentId:"<logo@app>",disposition:"inline",size:png.length,sha256:digest(png)}],
});
let record: PreviewRecord | null;
const deps: PreviewDependencies = {
  read: vi.fn(async () => record), digest,
  readAttachment: vi.fn(async () => ({ bytes: png })),
  fetchImage: vi.fn(async () => png),
  scan: vi.fn(async () => ({ status: "clean", sha256: digest(png) })),
  scanPolicy: vi.fn(() => ({ version: "policy-1", mode: "require_clean" as const })),
};
const service = () => createOutboundPreviewService(deps);
beforeEach(() => { vi.clearAllMocks(); record = fixture(); vi.mocked(deps.read).mockImplementation(async () => record); vi.mocked(deps.readAttachment).mockResolvedValue({bytes:png}); vi.mocked(deps.scanPolicy).mockReturnValue({version:"policy-1",mode:"require_clean"}); vi.mocked(deps.scan).mockResolvedValue({status:"clean",sha256:digest(png)}); });

describe("outbound preview resource ownership and lifetime", () => {
  it("resolves the exact frozen inline CID through protected attachment reads", async () => {
    const preview = service(), manifest = await preview.getPreview("delivery_a");
    expect(manifest.resources).toEqual([{id:"image_1",kind:"CID",available:true}]);
    expect(manifest.html).toContain('src="mail-resource:image_1"');
    expect(JSON.stringify(manifest)).not.toMatch(/file_logo|svc_a|logo@app/);
    const image = await preview.readResource("delivery_a", "image_1", manifest.revision, false);
    expect(image).toEqual({bytes:png,contentType:"image/png",sha256:digest(png)});
    expect(deps.readAttachment).toHaveBeenCalledWith("file_logo", "svc_a");
    expect(deps.scan).not.toHaveBeenCalled(); // CID retains its original attachment safety proof.
  });
  it.each(["missing", "duplicate", "case", "ordinary"])("does not guess a CID match for %s", async kind => {
    if (kind === "missing") record!.attachments = [];
    if (kind === "duplicate") record!.attachments.push({...record!.attachments[0],fileId:"file_duplicate"});
    if (kind === "case") record!.attachments[0].contentId = "Logo@app";
    if (kind === "ordinary") record!.attachments[0].disposition = "attachment";
    const preview = service(), manifest = await preview.getPreview("delivery_a");
    expect(manifest.resources[0].available).toBe(false);
    await expect(preview.readResource("delivery_a", "image_1", manifest.revision, false)).rejects.toMatchObject({code:"IMAGE_UNAVAILABLE"});
    expect(deps.readAttachment).not.toHaveBeenCalled();
  });
  it("rejects missing parents, stale revisions and resources outside the manifest before reading bytes", async () => {
    const preview = service(), manifest = await preview.getPreview("delivery_a");
    await expect(preview.readResource("delivery_a", "image_999", manifest.revision, true)).rejects.toMatchObject({status:404});
    record = {...record!, messageId:"msg_other"};
    await expect(preview.readResource("delivery_other", "image_1", manifest.revision, false)).rejects.toMatchObject({status:404});
    record = null;
    await expect(preview.getPreview("delivery_a")).rejects.toMatchObject({status:404});
    expect(deps.readAttachment).not.toHaveBeenCalled();
  });
  it("rejects a purge or revoked grant while attachment I/O is in progress", async () => {
    const preview = service(), manifest = await preview.getPreview("delivery_a");
    vi.mocked(deps.readAttachment).mockImplementation(async () => { record = null; return {bytes:png}; });
    await expect(preview.readResource("delivery_a", "image_1", manifest.revision, false)).rejects.toMatchObject({status:404});
  });
  it("rejects bytes that no longer match the accepted attachment snapshot", async () => {
    record!.attachments[0].sha256 = "a".repeat(64);
    const preview = service(), manifest = await preview.getPreview("delivery_a");
    await expect(preview.readResource("delivery_a", "image_1", manifest.revision, false)).rejects.toMatchObject({code:"IMAGE_UNAVAILABLE"});
  });
  it("bounds concurrent image preparation and releases capacity after a failure", async () => {
    const preview = service(), manifest = await preview.getPreview("delivery_a");
    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(deps.readAttachment).mockImplementation(async () => { await wait; return {bytes:png}; });
    const pending = Array.from({length:3}, () => preview.readResource("delivery_a", "image_1", manifest.revision, false));
    await vi.waitFor(() => expect(deps.readAttachment).toHaveBeenCalledTimes(3));
    await expect(preview.readResource("delivery_a", "image_1", manifest.revision, false)).rejects.toMatchObject({code:"IMAGE_BUSY"});
    finish(); await Promise.all(pending);
    await expect(preview.readResource("delivery_a", "image_1", manifest.revision, false)).resolves.toMatchObject({contentType:"image/png"});
  });
});

describe("outbound remote/embedded images and passive rendering", () => {
  it("requires explicit consent before any remote fetch, including tracking pixels", async () => {
    record!.html = '<img src="https://images.test/logo"><img src="https://images.test/pixel" width="1" height="1">';
    const preview = service(), manifest = await preview.getPreview("delivery_a");
    expect(manifest.resources).toHaveLength(2);
    expect(JSON.stringify(manifest)).not.toContain("images.test");
    await expect(preview.readResource("delivery_a", "image_1", manifest.revision, false)).rejects.toMatchObject({status:404});
    expect(deps.fetchImage).not.toHaveBeenCalled();
    await preview.readResource("delivery_a", "image_2", manifest.revision, true);
    expect(deps.fetchImage).toHaveBeenCalledWith("https://images.test/pixel", expect.any(Function));
    const authorize = vi.mocked(deps.fetchImage).mock.calls[0][1];
    record = null;
    await expect(authorize()).rejects.toMatchObject({status:404});
  });
  it("scans explicit bitmap data URIs without fetching any network URL", async () => {
    record!.html = `<img src="data:image/png;base64,${png.toString("base64")}">`;
    const preview = service(), manifest = await preview.getPreview("delivery_a");
    expect(manifest.resources[0]).toMatchObject({kind:"EMBEDDED",available:true});
    await expect(preview.readResource("delivery_a", "image_1", manifest.revision, false)).resolves.toMatchObject({contentType:"image/png"});
    expect(deps.scan).toHaveBeenCalledWith(png);
    expect(deps.fetchImage).not.toHaveBeenCalled();
  });
  it.each(["malicious", "unavailable", "verified"])("fails closed for a %s scan under require_clean", async status => {
    record!.html = '<img src="https://images.test/logo">';
    vi.mocked(deps.scan).mockResolvedValue({status,sha256:digest(png)});
    const preview = service(), manifest = await preview.getPreview("delivery_a");
    await expect(preview.readResource("delivery_a", "image_1", manifest.revision, true)).rejects.toMatchObject({code:"IMAGE_UNAVAILABLE"});
  });
  it("rechecks scanner policy after I/O even for CID attachments", async () => {
    const preview = service(), manifest = await preview.getPreview("delivery_a");
    vi.mocked(deps.readAttachment).mockImplementation(async () => { vi.mocked(deps.scanPolicy).mockReturnValue({version:"policy-2",mode:"require_clean"}); return {bytes:png}; });
    await expect(preview.readResource("delivery_a", "image_1", manifest.revision, false)).rejects.toMatchObject({code:"IMAGE_UNAVAILABLE"});
  });
  it("keeps CSS/srcset layouts, removes active content, and substitutes resources only in resource positions", async () => {
    record!.html = '<style>.brand{background:url(cid:logo@app)}</style><table background="cid:logo@app"><tr><td><img src="cid:logo@app" srcset="cid:logo@app 2x" alt="mail-resource:image_1" onerror="alert(1)">Literal mail-resource:image_1 <a href="https://example.test/mail-resource:image_1">link</a></td></tr></table><script>alert(1)</script><iframe src="https://evil.test"></iframe>';
    const manifest = await service().getPreview("delivery_a");
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    const html = renderMailPreview(manifest.html, new Map([["image_1",dataUrl]]));
    expect(html).toContain(MAIL_PREVIEW_CSP);
    expect(html).toContain(`src="${dataUrl}"`);
    expect(html).toContain(`srcset="${dataUrl} 2x"`);
    expect(html).toContain(`url("${dataUrl}")`);
    expect(html).toContain('alt="mail-resource:image_1"');
    expect(html).toContain('Literal mail-resource:image_1');
    expect(html).toContain('href="https://example.test/mail-resource:image_1"');
    expect(html).not.toMatch(/onerror|<script|<iframe|cid:/);
    expect(renderMailPreview(manifest.html,new Map())).toContain('src="data:image/gif;base64,');
    for (const unsafe of ["blob:http://localhost/id","https://images.test/image","data:image/svg+xml;base64,PHN2Zy8+"]) {
      expect(renderMailPreview(manifest.html,new Map([["image_1",unsafe]]))).not.toContain(`src="${unsafe}"`);
    }
  });
});
