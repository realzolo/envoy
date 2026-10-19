import { afterEach,describe,expect,it,vi } from "vitest";
import { scanBytes, scanPolicy, digest } from "@/modules/attachments/public";
import { scannerFixture } from "../helpers/scanner";

const bytes=Buffer.from("controlled harmless bytes");
afterEach(()=>vi.unstubAllEnvs());
describe("bounded attachment scanner protocol",()=>{
 it.each([
  ["stream: OK\0","clean",null],
  ["stream: Fixture.Signature FOUND\0","malicious","FILE_MALICIOUS"],
  ["not OK\0","unavailable","SCAN_PROTOCOL_INVALID"],
  ["stream: OK\0extra","unavailable","SCAN_PROTOCOL_INVALID"],
  ["stream: OK\n","unavailable","SCAN_PROTOCOL_INVALID"],
  ["stream: ERROR\0","unavailable","SCAN_PROTOCOL_INVALID"],
  ["x".repeat(5000),"unavailable","SCAN_PROTOCOL_INVALID"],
 ])("parses exactly one bounded response (%s)",async(reply,status,reason)=>{
  const fixture=await scannerFixture(reply!);
  try {expect(await scanBytes(bytes)).toEqual({status,reason,sha256:digest(bytes)});}finally{await fixture.close();}
 });
 it("keeps absent scanners unscanned, without pretending a clean result",async()=>{
  vi.stubEnv("CLAMAV_HOST","");expect(await scanBytes(bytes)).toMatchObject({status:"unavailable",reason:"SCAN_NOT_CONFIGURED"});
 });
 it("verifies bytes without claiming a malware scan when scanning is explicitly disabled",async()=>{
  vi.stubEnv("ATTACHMENT_SCAN_MODE","integrity_only");vi.stubEnv("CLAMAV_HOST","");
  expect(scanPolicy()).toMatchObject({mode:"integrity_only",version:"integrity:1",configured:false});
  expect(await scanBytes(bytes)).toEqual({status:"verified",reason:null,sha256:digest(bytes)});
  expect(await scanBytes(Buffer.alloc(10_000_001))).toMatchObject({status:"unavailable",reason:"FILE_SIZE_EXCEEDED"});
 });
 it("rejects unknown scan modes",()=>{
  vi.stubEnv("ATTACHMENT_SCAN_MODE","skip");expect(scanPolicy).toThrow("Invalid Envoy attachment safety configuration");
 });
 it("bounds the total time even when a connection stays open",async()=>{
  const fixture=await scannerFixture(null);vi.stubEnv("CLAMAV_TIMEOUT_MS","100");
  try {expect(await scanBytes(bytes)).toMatchObject({status:"unavailable",reason:"SCAN_TIMEOUT"});}finally{await fixture.close();}
 });
 it("handles mid-command disconnects and releases capacity",async()=>{
  const fixture=await scannerFixture(null,socket=>socket.once("data",()=>socket.destroy()));
  try {for(let i=0;i<6;i++) expect((await scanBytes(bytes)).status).toBe("unavailable");}finally{await fixture.close();}
 });
 it("limits concurrency without an unbounded waiting list",async()=>{
  const fixture=await scannerFixture(null);vi.stubEnv("ATTACHMENT_SCAN_CONCURRENCY","1");vi.stubEnv("CLAMAV_TIMEOUT_MS","100");
  try {const first=scanBytes(bytes);expect(await scanBytes(bytes)).toMatchObject({reason:"SCAN_CAPACITY_BUSY"});await first;}finally{await fixture.close();}
 });
 it("bounds byte size before opening a connection",async()=>{
  expect(await scanBytes(Buffer.alloc(10_000_001))).toMatchObject({status:"unavailable",reason:"FILE_SIZE_EXCEEDED"});
 });
 it("bounds blocked writes when the peer never reads a large stream",async()=>{
  const fixture=await scannerFixture(null,socket=>socket.pause());vi.stubEnv("CLAMAV_TIMEOUT_MS","100");
  try {expect(await scanBytes(Buffer.alloc(10_000_000))).toMatchObject({status:"unavailable",reason:"SCAN_TIMEOUT"});}finally{await fixture.close();}
 });
 it("does not accept a premature clean response before the stream has been sent",async()=>{
  const fixture=await scannerFixture(null,socket=>socket.end("stream: OK\0"));
  try {expect((await scanBytes(Buffer.alloc(10_000_000))).status).toBe("unavailable");}finally{await fixture.close();}
 });
 it("rejects invalid response encoding instead of treating it as a malware signature",async()=>{
  const fixture=await scannerFixture(null,socket=>socket.once("data",()=>socket.end(Buffer.concat([Buffer.from("stream: "),Buffer.from([255]),Buffer.from(" FOUND\0")]))));
  try {expect((await scanBytes(bytes)).status).toBe("unavailable");}finally{await fixture.close();}
 });
});
