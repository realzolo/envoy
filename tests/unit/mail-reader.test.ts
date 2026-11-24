import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { beforeEach,describe,expect,it,vi } from "vitest";
import { createReaderService,imageType,type ReaderDependencies } from "@/modules/mail-reader/application/service";
import { compileReader } from "@/modules/mail-reader/domain/document";
import { renderReader } from "@/modules/mail-reader/domain/frame";
import type { ReaderSource } from "@/modules/mail-reader/contracts";
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=","base64");
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
let source:ReaderSource|null,now:number;
const target={kind:"INBOUND" as const,id:"inb_1",serviceId:"svc_1"};
const cache={get:vi.fn(),enqueue:vi.fn(),claim:vi.fn(),store:vi.fn(),fail:vi.fn(),retryFailed:vi.fn()};
const deps:ReaderDependencies={cache,readSource:vi.fn(async()=>source),digest,seal:value=>Buffer.from(JSON.stringify(value)).toString("base64url"),open:token=>JSON.parse(Buffer.from(token,"base64url").toString()),randomId:()=>"a".repeat(32),now:()=>now,readAttachment:vi.fn(),fetchImage:vi.fn()};
beforeEach(()=>{
 vi.clearAllMocks();now=1_000_000;source={kind:"INBOUND",id:"inb_1",serviceId:"svc_1",html:'<html><head><style>.x{--brand:#123;color:var(--brand);background:url(https://image.test/bg.svg)}@media(max-width:600px){.x{width:100%}}</style></head><body><table><tr><td><img src="cid:logo" width="100" height="40"><img src="https://image.test/one.gif" width="1" height="1"></td></tr></table></body></html>',text:"Independent",attachments:[{id:"attachment_1",contentId:"<logo>",contentType:"image/png",size:png.length,sha256:digest(png)}]};
 cache.get.mockResolvedValue(null);cache.enqueue.mockResolvedValue(undefined);cache.claim.mockResolvedValue({token:"lease",serviceId:"svc_1"});cache.store.mockResolvedValue(true);cache.fail.mockResolvedValue(undefined);cache.retryFailed.mockResolvedValue(1);
 vi.mocked(deps.readAttachment).mockResolvedValue({bytes:png});vi.mocked(deps.fetchImage).mockResolvedValue(png);
});
const tokenOf=(url:string)=>url.split("/").at(-1)!;
describe("unified hosted mail reader",()=>{
 it("preserves original CSS/size/table layout and resolves CID, remote, one-pixel and CSS resources through one manifest",()=>{
  const result=compileReader(source!);expect(result.html).toContain("--brand:#123");expect(result.html).toContain("var(--brand)");expect(result.html).toContain("@media");expect(result.html).toContain('width="100" height="40"');expect(result.resources).toHaveLength(3);expect(result.resources.map(r=>r.kind)).toEqual(["REMOTE","CID","REMOTE"]);
 });
 it("resolves only actual resource positions against an explicit original base and preserves literal reader-like author text",async()=>{
  source!.html='<html><head><base href="https://cdn.example.test/mail/"></head><body><p>mail-reader-resource:resource_1</p><img src="logo.png" alt="mail-reader-resource:resource_1"><div style="background:url(../bg.png);--label:mail-reader-resource:resource_1"></div></body></html>';
  const document=compileReader(source!);expect(document.resources.map(item=>item.source)).toEqual(["https://cdn.example.test/mail/logo.png","https://cdn.example.test/bg.png"]);expect(document.html).not.toContain("<base");
  const reader=createReaderService(deps),session=await reader.issue(target,"https://envoy.test"),token=tokenOf(session.url),current=await reader.document(token),html=renderReader(current.document,token,current.grant,"https://envoy.test","nonce");
  expect(html).toContain('<p>mail-reader-resource:resource_1</p>');expect(html).toContain('alt="mail-reader-resource:resource_1"');expect(html).toContain('--label:mail-reader-resource:resource_1');
 });
 it("retries failed resources only for explicit idempotent demand and never while issuing or checking a session",async()=>{
  const reader=createReaderService(deps),session=await reader.issue(target,"https://envoy.test"),token=tokenOf(session.url);await reader.status(token);expect(cache.retryFailed).not.toHaveBeenCalled();await reader.retry(token,"explicit-operation-id");expect(cache.retryFailed).toHaveBeenCalledWith(expect.objectContaining({kind:"INBOUND",id:"inb_1",revision:session.documentRevision}),"svc_1","explicit-operation-id");
 });
 it("signs a short independent capability and enqueues every resource without synchronously fetching its bytes",async()=>{
  const session=await createReaderService(deps).issue(target,"https://envoy.test");expect(session).toMatchObject({channelId:"a".repeat(32),expiresAt:new Date(now+120_000).toISOString()});expect(session.documentRevision).toMatch(/^[a-f0-9]{64}$/);expect(cache.enqueue).toHaveBeenCalledTimes(3);expect(deps.fetchImage).not.toHaveBeenCalled();expect(session.url).toMatch(/^https:\/\/envoy.test\/mail-reader\/[A-Za-z0-9_-]+$/);
 });
 it("refuses altered/expired capabilities, revoked sources and changed original source revisions",async()=>{
  const reader=createReaderService(deps),session=await reader.issue(target,"https://envoy.test"),token=tokenOf(session.url);
  await expect(reader.document("malformed")).rejects.toMatchObject({status:404});now+=120_000;await expect(reader.document(token)).rejects.toMatchObject({status:410});now-=120_000;
  const original=source;source=null;await expect(reader.document(token)).rejects.toMatchObject({status:404});source={...original!,html:"Changed"};await expect(reader.document(token)).rejects.toMatchObject({status:404});
 });
 it("prepares real CID bytes from the same original message and stores one reusable result",async()=>{
  const reader=createReaderService(deps),session=await reader.issue(target,"https://envoy.test"),token=tokenOf(session.url);
  const image=await reader.readResource(token,"resource_2");expect(image).toEqual({bytes:png,contentType:"image/png",sha256:digest(png)});expect(deps.readAttachment).toHaveBeenCalledWith("inbound","attachment_1","svc_1","inb_1");expect(cache.store).toHaveBeenCalledOnce();
  cache.get.mockResolvedValue({state:"READY",bytes:png,contentType:"image/png",sha256:digest(png)});await reader.readResource(token,"resource_2");expect(deps.readAttachment).toHaveBeenCalledTimes(1);
 });
 it("fences late image publication on source revocation and returns no bytes",async()=>{
  const reader=createReaderService(deps),session=await reader.issue(target,"https://envoy.test");vi.mocked(deps.fetchImage).mockImplementation(async()=>{source=null;return png;});
  await expect(reader.readResource(tokenOf(session.url),"resource_1")).rejects.toMatchObject({status:404});expect(cache.store).not.toHaveBeenCalled();
 });
 it("aggregates per-resource status without loading cache bytes or fetching remote images",async()=>{
  const reader=createReaderService(deps),session=await reader.issue(target,"https://envoy.test");cache.get.mockResolvedValue({state:"RETRY_WAIT",reasonCode:"READING_FETCH_FAILED",sha256:null,updatedAt:"now"});
  const result=await reader.status(tokenOf(session.url));expect(result.resources).toHaveLength(3);expect(result.resources.every(r=>r.state==="RETRY_WAIT")).toBe(true);expect(cache.get.mock.calls.every(call=>call[1]===false)).toBe(true);expect(deps.fetchImage).not.toHaveBeenCalled();
 });
 it("renders one live iframe with controlled scripts, resource endpoints, resize messages and in-place renewal",async()=>{
  const reader=createReaderService(deps),session=await reader.issue(target,"https://envoy.test"),token=tokenOf(session.url),document=await reader.document(token);
  const html=renderReader(document.document,token,document.grant,"https://envoy.test","nonce");expect(html).toContain("/resources/resource_1");expect(html).not.toContain("mail-reader-resource:");expect(html).toContain("/mail-reader/runtime.v2.js");expect(html).toContain("data-envoy-reader-config");expect(html).not.toContain("innerHTML");
 });
 it("updates failed image and CSS resource slots in place and renews the opaque capability without rebuilding the document",async()=>{
  const reader=createReaderService(deps),session=await reader.issue(target,"https://envoy.test"),token=tokenOf(session.url);
  const script=readFileSync(new URL("../../public/mail-reader/runtime.v2.js",import.meta.url),"utf8");
  const base=`https://envoy.test/mail-reader/${token}`,attributes=new Map([["style",`background:url("${base}/resources/resource_1")`],["src",`${base}/resources/resource_2`]]);
  const element={tagName:"IMG",textContent:null,getAttribute:(key:string)=>attributes.get(key)??null,setAttribute:(key:string,value:string)=>attributes.set(key,value)};
  const listeners=new Map<string,(event:unknown)=>void>(),parent={postMessage:vi.fn()},fetch=vi.fn(async()=>({ok:true,status:200,json:async()=>({resources:[{id:"resource_1",state:"READY",sha256:"a".repeat(64)},{id:"resource_2",state:"READY",sha256:"b".repeat(64)}]})}));
  runInNewContext(script,{parent,document:{currentScript:{getAttribute:()=>JSON.stringify({base:`https://envoy.test/mail-reader/${token}`,origin:"https://envoy.test",channelId:session.channelId,revision:session.documentRevision,expiresAt:now+120_000})},body:{scrollHeight:800},documentElement:{scrollHeight:800},querySelectorAll:()=>[element],addEventListener:()=>{}},Date:{now:()=>now,parse:Date.parse},ResizeObserver:class{observe(){}},fetch,URL,addEventListener:(key:string,handler:(event:unknown)=>void)=>listeners.set(key,handler),setTimeout:vi.fn(),clearTimeout:vi.fn()});
  for(let i=0;i<10;i++)await Promise.resolve();
  expect(attributes.get("style")).toContain("?v="+"a".repeat(16));expect(attributes.get("src")).toContain("?v="+"b".repeat(16));
  listeners.get("message")!({source:parent,data:{type:"envoy:mail-reader:renew",channelId:session.channelId,session:{...session,url:"https://envoy.test/mail-reader/renewedToken",channelId:"c".repeat(32)}}});
  for(let i=0;i<10;i++)await Promise.resolve();
  expect(attributes.get("src")).toContain("/mail-reader/renewedToken/resources/");expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({channelId:"c".repeat(32)}),"*");
 });
 it("accepts original SVG and AVIF image bytes as well as native animated formats",()=>{
  expect(imageType(Buffer.from('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg/>'))).toBe("image/svg+xml");expect(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("image/svg+xml");expect(imageType(Buffer.from("0000ftypavif0000"))).toBe("image/avif");expect(imageType(Buffer.from("GIF89a0000000"))).toBe("image/gif");expect(imageType(Buffer.from("not an image"))).toBeNull();
 });
});
