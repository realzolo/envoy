import {describe,it,expect} from "vitest";
import {simpleParser} from "mailparser";
import {canonicalContentId,projectDocument,type DocumentSource} from "@/modules/inbound/domain/document";
import {bitmapInfo} from "@/modules/inbound/domain/bitmap";
import {mediaTarget,fetchDocumentImage} from "@/modules/inbound/infrastructure/document-media";
const source=(html:string):DocumentSource=>({html,text:"Author text https://example.test/a data:image/png;base64,NOT_AN_IMAGE",textProvenance:"AUTHORED",attachments:[{id:"ina_a",contentId:"<image@a>"}]});
function project(html:string){let i=0;return projectDocument(source(html),{revision:"1",digest:"a".repeat(64),id:()=>`idr_${++i}`});}
describe("passive inbound document fidelity and privacy",()=>{
 it("retains authored tables/styles/classes while separating every image source",()=>{
  const result=project(`<html><head><style>.brand{color:#245; background-image:url(https://images.test/background.png)}@media(max-width:600px){.brand{width:100%}}</style></head><body><table class="brand" cellpadding="12"><tr><td colspan="2" style="font-size:18px;padding:10px;background:url('cid:image%40a')"><img src="cid:image@a" alt="Logo"><img src="https://images.test/logo.png" width="300" height="100"></td></tr></table></body></html>`);
  expect(result.html).toContain('colspan="2"');expect(result.html).toContain('class="brand"');expect(result.html).toContain('font-size:18px');expect(result.html).toContain('@media');
  expect(result.html).not.toContain('https://images.test');expect(result.html).not.toContain('cid:');expect(result.document.primaryRepresentation).toBe('HTML');
  expect(result.document.resources).toHaveLength(3);expect(result.document.resources.find(x=>x.kind==='CID')).toMatchObject({contentId:'image@a',attachmentId:'ina_a'});
  expect(result.text).toBe(source('').text);expect(JSON.stringify(result.document)).not.toContain('https://');
 });
 it("drops active/network CSS exits without discarding unrelated safe declarations or author text",()=>{
  const result=project(`<style>@import url(https://evil.test/x);@font-face{font-family:x;src:url(https://evil.test/font)}.good\\:name{padding:12px;color:red;background:u\\72l(https://evil.test)}.x{position:fixed;behavior:url(https://evil.test);width:expression(alert(1))}</style><script>alert(1)</script><iframe src="https://evil.test"></iframe><img src="javascript:alert(1)" srcset="https://evil.test 2x"><a href="javascript:alert(1)">Original https://author.test / data:image/png;base64,AA==</a>`);
  expect(result.html).toContain('padding:12px');expect(result.html).toContain('Original https://author.test / data:image/png;base64,AA==');
  expect(result.html).not.toMatch(/script|iframe|@import|font-face|expression|position:fixed|u\\72l/);
  expect(result.html).not.toContain('https://evil.test');
 });
 it("never guesses image data from text and blocks ambiguous CID/known tracking",()=>{
  const result=project('<img src="cid:missing"><img src="https://tracker.test/one" width="1" height="1">');
  expect(result.document.resources).toMatchObject([{kind:'CID',state:'UNAVAILABLE',reasonCode:'SOURCE_UNAVAILABLE'},{kind:'REMOTE',state:'BLOCKED',reasonCode:'TRACKING_RISK',downloadEligible:false}]);
  expect(project('<img src="https://tracker.test/shared" width="300" height="100"><img src="https://tracker.test/shared" width="1" height="1">').document.resources).toMatchObject([{state:'BLOCKED',reasonCode:'TRACKING_RISK',downloadEligible:false}]);
  expect(result.document.resources).toHaveLength(2);expect(canonicalContentId('<Case@ID>')).toBe('Case@ID');expect(canonicalContentId('a\u00a0b')).toBeNull();
 });
 it("preserves explicit cited-reply provenance and literal sender attachment placeholders",()=>{
  const result=project('<p>New reply</p><blockquote type="cite"><span id="cid:app-logo">&lt;app-logo.png&gt;</span><span id="cid:attachment">&lt;document.md&gt;</span></blockquote><blockquote type="not-cite">Actual body quotation</blockquote>');
  expect(result.html).toContain('<blockquote type="cite">');expect(result.html).not.toContain('type="not-cite"');
  expect(result.html).toContain('&lt;app-logo.png&gt;');expect(result.html).toContain('&lt;document.md&gt;');
  expect(result.document.resources).toEqual([]);
 });
 it("retains srcset-only images as controlled candidates and honestly marks truncation/empty HTML",()=>{
  const result=project('<picture><source srcset="https://image.test/a 1x, https://image.test/b 2x"><img srcset="https://image.test/a 1x, https://image.test/b 2x"></picture>');
  expect(result.html).toContain('srcset="mail-resource:');expect(result.html).toContain('src="mail-resource:');expect(result.document.resources).toHaveLength(2);expect(result.html).not.toContain('https://');
  expect(project('<script>alert(1)</script><div> </div>').document.primaryRepresentation).toBe('TEXT');
  const large=projectDocument({...source('<p>HTML</p>'),text:'x'.repeat(2_000_001)},{revision:'1',digest:null,id:()=> 'idr_x'});expect(large.document.state).toBe('PARTIAL');expect(Buffer.byteLength(large.text!)).toBe(2_000_000);
 });
 it("projects NUL and non-scalar Unicode explicitly without altering retained source",()=>{
  const original={...source('<p>A\u0000B\ud800</p>'),text:'A\u0000B\ud800'};
  const result=projectDocument(original,{revision:'1',digest:null,id:()=> 'idr_null'});expect(result.html).toBe('<p>A�B�</p>');expect(result.text).toBe('A�B�');expect(result.document.state).toBe('PARTIAL');expect(original.text).toContain('\u0000');
 });
 it("parses real independent MIME text and keeps actual CID instead of synthesized data URIs",async()=>{
  const mime='MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=a\r\n\r\n--a\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<table><tr><td><img src="cid:logo"></td></tr></table>\r\n--a\r\nContent-Type: image/png\r\nContent-ID: <logo>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n--a--';
  const parsed=await simpleParser(mime,{skipHtmlToText:true,skipTextToHtml:true,keepCidLinks:true});expect(parsed.text).toBeUndefined();expect(parsed.html).toContain('cid:logo');expect(parsed.attachments[0].cid).toBe('logo');
 });
});
describe("restricted document media",()=>{
 it("rejects localhost, private/mixed DNS, metadata, credential and non-image protocol targets",async()=>{
  for(const url of ['http://127.0.0.1/x','https://[::1]/x','http://169.254.169.254/x','file:///etc/passwd','https://u:p@public.test/x','http://0x7f000001/x','https://public.test:8443/x'])await expect(mediaTarget(url)).rejects.toThrow('NETWORK_BLOCKED');
  await expect(mediaTarget('https://public.test/x',async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}])).rejects.toThrow('NETWORK_BLOCKED');
  expect((await mediaTarget('https://public.test/x',async()=>[{address:'8.8.8.8',family:4}])).url.hostname).toBe('public.test');
 });
 it("bounds even a DNS resolver which does not return",async()=>{
  await expect(fetchDocumentImage('https://image.test/a',async()=>{},()=>new Promise(()=>{}),5)).rejects.toThrow('FETCH_FAILED');
 });
 it("checks byte magic and dimensions independently of declared MIME",()=>{
  const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(10,16);png.writeUInt32BE(10,20);expect(bitmapInfo(png)).toMatchObject({contentType:'image/png',width:10,height:10});
  png.writeUInt32BE(16385,16);expect(()=>bitmapInfo(png)).toThrow('PIXEL_LIMIT');expect(()=>bitmapInfo(Buffer.from('<svg/>'))).toThrow('UNSUPPORTED_TYPE');
 });
});
