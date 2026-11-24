import { beforeEach,describe,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({admin:vi.fn(),issue:vi.fn(),document:vi.fn(),image:vi.fn(),status:vi.fn()}));
vi.mock("@/server/admin-auth",()=>({getAdminSession:mocks.admin}));
vi.mock("@/modules/mail-reader/public",async()=>({...await import("@/modules/mail-reader/application/service"),mailReader:{issue:mocks.issue,document:mocks.document,readResource:mocks.image,status:mocks.status},renderReader:()=>"<html>Original</html>"}));
import { GET as frame } from "@/app/mail-reader/[token]/route";
import { POST as session } from "@/app/api/admin/inbound/[id]/reading-session/route";
import { GET as image } from "@/app/mail-reader/[token]/resources/[resourceId]/route";
import { GET as status } from "@/app/mail-reader/[token]/status/route";
import { ReaderError } from "@/modules/mail-reader/application/service";
const descriptor={url:"https://envoy.test/mail-reader/opaque",expiresAt:"2026-11-24T12:00:00Z",documentRevision:"a".repeat(64),channelId:"b".repeat(32)};
beforeEach(()=>{vi.clearAllMocks();mocks.admin.mockResolvedValue(null);mocks.issue.mockResolvedValue(descriptor);});
describe("reading HTTP authority and opaque iframe",()=>{
 it("requires admin authority to issue a capability but never administrator cookies to redeem a capability",async()=>{
  const request=new Request("https://envoy.test/api/admin/inbound/id/reading-session",{method:"POST"});
  expect((await session(request,{params:Promise.resolve({id:"inb_1"})})).status).toBe(401);expect(mocks.issue).not.toHaveBeenCalled();
  mocks.admin.mockResolvedValue({email:"admin@example.test"});const response=await session(request,{params:Promise.resolve({id:"inb_1"})});expect(await response.json()).toEqual(descriptor);expect(mocks.issue).toHaveBeenCalledWith({kind:"INBOUND",id:"inb_1",serviceId:null},"https://envoy.test");
  mocks.status.mockResolvedValue({resources:[]});expect((await status(new Request("https://envoy.test/mail-reader/opaque/status"),{params:Promise.resolve({token:"opaque"})})).status).toBe(200);
 });
 it("returns uncredentialed capability CORS and exact native image MIME/bytes",async()=>{
  mocks.image.mockResolvedValue({bytes:Buffer.from('<svg/>'),contentType:"image/svg+xml",sha256:"a".repeat(64)});
  const response=await image(new Request("https://envoy.test/mail-reader/opaque/resources/resource_1"),{params:Promise.resolve({token:"opaque",resourceId:"resource_1"})});
  expect(response.headers.get("access-control-allow-origin")).toBe("*");expect(response.headers.get("access-control-allow-credentials")).toBeNull();expect(response.headers.get("content-type")).toBe("image/svg+xml");expect(response.headers.get("cache-control")).toBe("private, no-store, no-transform");expect(await response.text()).toBe("<svg/>");
 });
 it("delivers original reader HTML without intermediary transformations",async()=>{
  mocks.document.mockResolvedValue({document:{html:"<p>test.envoy@sonaops.space</p>",resources:[]},grant:{}});
  const response=await frame(new Request("https://envoy.test/mail-reader/opaque"),{params:Promise.resolve({token:"opaque"})});
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("private, no-store, no-transform");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response.text()).toBe("<html>Original</html>");
 });
 it("rejects malformed resource IDs and returns finite expiry/source errors",async()=>{
  expect((await image(new Request("https://envoy.test"),{params:Promise.resolve({token:"opaque",resourceId:"../private"})})).status).toBe(404);expect(mocks.image).not.toHaveBeenCalled();
  mocks.status.mockRejectedValue(new ReaderError(410,"READING_SESSION_EXPIRED"));const expired=await status(new Request("https://envoy.test"),{params:Promise.resolve({token:"opaque"})});expect(expired.status).toBe(410);expect(await expired.json()).toEqual({code:"READING_SESSION_EXPIRED"});
 });
});
