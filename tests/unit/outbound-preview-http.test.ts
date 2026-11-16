import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session:vi.fn(), preview:vi.fn(), image:vi.fn() }));
vi.mock("@/server/admin-auth", () => ({getAdminSession:mocks.session}));
vi.mock("@/modules/outbound/public", async () => ({
  getOutboundPreview:mocks.preview, readOutboundPreviewResource:mocks.image,
  PreviewAccessError:(await import("@/modules/outbound/application/preview")).PreviewAccessError,
}));
import { GET as getPreview } from "@/app/api/admin/deliveries/[id]/preview/route";
import { GET as getImage } from "@/app/api/admin/deliveries/[id]/preview/[resourceId]/route";
import { PreviewAccessError } from "@/modules/outbound/application/preview";
const revision = "a".repeat(64);
const request = (query = "", headers:Record<string,string> = {}) => new Request(`http://localhost/api/admin/deliveries/delivery_a/preview/image_1?revision=${revision}${query}`,{headers});
const context = {params:Promise.resolve({id:"delivery_a",resourceId:"image_1"})};
beforeEach(() => {vi.clearAllMocks();mocks.session.mockResolvedValue({email:"admin@example.test"});});

describe("authenticated preview HTTP boundary", () => {
  it("requires an admin session for both HTML and image bytes", async () => {
    mocks.session.mockResolvedValue(null);
    for (const handler of [getPreview,getImage]) {
      const response = await handler(request(),context);
      expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.image).not.toHaveBeenCalled();
  });
  it("returns a private manifest with no shared cache", async () => {
    const manifest = {html:'<img src="mail-resource:image_1">',revision,resources:[]};
    mocks.preview.mockResolvedValue(manifest);
    const response = await getPreview(request(),context);
    expect(await response.json()).toEqual(manifest); expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("returns byte-verified raster headers and requires a same-origin opt-in header for remote reads", async () => {
    mocks.image.mockResolvedValue({bytes:Uint8Array.from([1,2,3]),contentType:"image/png",sha256:revision});
    const response = await getImage(request("&allowRemote=true"),context);
    expect(mocks.image).toHaveBeenLastCalledWith("delivery_a","image_1",revision,false);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe("3"); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff"); expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([1,2,3]));
    await getImage(request("",{"x-envoy-load-remote":"true"}),context);
    expect(mocks.image).toHaveBeenLastCalledWith("delivery_a","image_1",revision,true);
  });
  it("rejects malformed resource IDs/revisions and does not expose internal errors", async () => {
    expect((await getImage(new Request("http://localhost/image?revision=bad"),context)).status).toBe(404);
    expect((await getImage(request(),{params:Promise.resolve({id:"delivery_a",resourceId:"../private"})})).status).toBe(404);
    expect(mocks.image).not.toHaveBeenCalled();
    mocks.image.mockRejectedValue(new PreviewAccessError(409,"IMAGE_UNAVAILABLE"));
    const response = await getImage(request(),context);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({code:"IMAGE_UNAVAILABLE"});
  });
});
