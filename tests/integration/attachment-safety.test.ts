import { fork } from "node:child_process";
import type { Job } from "bullmq";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { query, db } from "@/platform/database";
import { hashApiKey } from "@/platform/crypto/hash";
import { createId } from "@/platform/ids";
import { createMessageSchema,outboundFileSchema } from "@/lib/contracts";
import { getOutboundFile, uploadOutboundFile } from "@/modules/attachments/public";
import { processAttachmentScan, retryAttachmentScan, scheduleAttachmentScans } from "@/modules/attachments/public";
import { downloadAttachment } from "@/modules/attachments/public";
import { purgeContent } from "@/modules/identity/public";
import { acceptMessage, cancelMessage } from "@/modules/outbound/public";
import { processDelivery } from "@/worker/delivery";
import { providerRegistry } from "@/integrations/providers/registry";
import { objectStore } from "@/platform/storage/object-store";
import { persistInbound } from "@/modules/inbound/public";
import { getInboundAttachment, getInboundMessage } from "@/modules/inbound/public";
import { POST as sendAPI } from "@/app/api/v1/messages/route";
import { GET as fileAPI } from "@/app/api/v1/files/[id]/route";
import { GET as downloadAPI } from "@/app/api/v1/files/[id]/download/route";
import { POST as reprocessAPI } from "@/app/api/v1/files/[id]/reprocess/route";
import { POST as reprocessInboundAPI } from "@/app/api/v1/inbound-messages/[id]/attachments/[attachmentId]/reprocess/route";
import { DELETE as eraseAPI } from "@/app/api/v1/files/[id]/content/route";
import { scannerFixture,scanClean } from "../helpers/scanner";
import { ATTACHMENT_QUEUE, closeQueues, createQueueWorker } from "@/platform/queues";
import { dispatchOutboxBatch } from "@/platform/outbox/public";

const tag=createId("safety"),a=`svc_${tag}_a`,b=`svc_${tag}_b`,key=`fixture_${tag}`;
const identity={serviceId:a,serviceName:"Attachment safety",rateLimitPerMinute:600};
const bytes=Buffer.from("harmless fixture bytes");
const input=(files:string[])=>createMessageSchema.parse({category:"security",from:{email:"safe@mail.atlas.test"},to:[{email:"recipient@example.test"}],text:"body",
  attachments:files.map((fileId,index)=>({fileId,disposition:index ? "inline" : "attachment",...(index ? {contentId:`cid-${index}`} : {})}))});
const request=(path:string,method="GET",body?:unknown,operation=createId("op"))=>new Request(`https://envoy.test/api/v1${path}`,{method,
  headers:{authorization:`Bearer ${key}`,"content-type":"application/json","idempotency-key":operation},...(body ? {body:JSON.stringify(body)} : {})});
const file=()=>uploadOutboundFile(a,"private.bin","application/octet-stream",bytes,"mail.atlas.test");
const row=async(id:string)=>(await query("SELECT * FROM attachment_safety WHERE resource_id=$1",[id])).rows[0];
const job=(submissionId:string)=>({data:{submissionId}} as Job<{submissionId:string}>);
const submission=async(messageId:string)=>(await query<{id:string}>("SELECT id FROM submissions WHERE message_id=$1",[messageId])).rows[0].id;

beforeAll(async()=>{
 await query("INSERT INTO services(id,name) VALUES($1,$1),($2,$2)",[a,b]);
 await query("INSERT INTO service_credentials(id,service_id,key_prefix,key_hash) VALUES($1,$2,'fixture',$3)",[`cred_${tag}`,a,hashApiKey(key)]);
 await query("INSERT INTO service_domain_bindings(id,service_id,sending_domain_id,receive_enabled,outbound_provider_identity_id) VALUES($1,$2,'sd_atlas',true,'pi_atlas_mock')",[`binding_${tag}`,a]);
 await query("INSERT INTO service_domain_bindings(id,service_id,sending_domain_id,receive_enabled,outbound_provider_identity_id) VALUES($1,$2,'sd_atlas',false,'pi_atlas_mock')",[`binding_${tag}_b`,b]);
});
afterAll(async()=>{
 const objects=(await query<{object_key:string}>(`SELECT object_key FROM outbound_files WHERE service_id=ANY($1)
  UNION ALL SELECT a.object_key FROM inbound_attachments a JOIN inbound_messages i ON i.id=a.inbound_message_id WHERE i.service_id=ANY($1)`,[[a,b]])).rows;
 for(const object of objects) await objectStore().delete(object.object_key);
 await query("DELETE FROM messages WHERE service_id=ANY($1)",[[a,b]]);
 await query("DELETE FROM outbound_files WHERE service_id=ANY($1)",[[a,b]]);
 await query("DELETE FROM inbound_messages WHERE service_id=ANY($1)",[[a,b]]);
 await query("DELETE FROM services WHERE id=ANY($1)",[[a,b]]);
 await db().end();
});

describe("private attachment safety lifecycle",()=>{
 it("receives bytes durably but rejects direct message acceptance until scan completes, without consuming the operation key",async()=>{
  const uploaded=outboundFileSchema.parse(await file()),operation=createId("stable");
  expect(uploaded).toMatchObject({contentAvailable:true,usage:{state:"processing",canSend:false,safetyState:"unscanned"}});
  const payload=input([uploaded.id]);
  const rejected=await sendAPI(request("/messages","POST",payload,operation));
  expect(rejected.status).toBe(409);expect(await rejected.json()).toMatchObject({code:"FILE_NOT_READY"});
  expect((await query("SELECT id FROM messages WHERE service_id=$1 AND idempotency_key=$2",[a,operation])).rowCount).toBe(0);
  await scanClean(uploaded.id);
  expect(await getOutboundFile(uploaded.id,a)).toMatchObject({usage:{state:"usable",canSend:true,canDownload:true}});
  const accepted=await sendAPI(request("/messages","POST",payload,operation)),receipt=await accepted.json();
  expect(accepted.status).toBe(202);
  const duplicate=await sendAPI(request("/messages","POST",payload,operation));expect((await duplicate.json()).id).toBe(receipt.id);
  const send=vi.spyOn(providerRegistry("mock").sender,"send");
  try {await processDelivery(job(await submission(receipt.id)));expect(send).toHaveBeenCalledTimes(1);}finally{send.mockRestore();}
  expect(await (await downloadAttachment("outbound",uploaded.id,a))!.text()).toBe(bytes.toString());
 });
 it("blocks a whole multi-attachment/CID request and rechecks all attachments before the provider boundary",async()=>{
  const good=await file(),other=await file();await scanClean(good.id);
  await expect(acceptMessage({identity,input:input([good.id,other.id]),idempotencyKey:createId("op")})).rejects.toMatchObject({code:"FILE_NOT_READY"});
  await scanClean(other.id);const accepted=await acceptMessage({identity,input:input([good.id,other.id]),idempotencyKey:createId("op")});
  await retryAttachmentScan(other.id,"outbound",a,"fixture");
  const fixture=await scannerFixture("stream: Fixture.Bad FOUND\0");
  try {await processAttachmentScan(other.id);}finally{await fixture.close();}
  const send=vi.spyOn(providerRegistry("mock").sender,"send");
  try {await processDelivery(job(await submission(accepted.message.id)));expect(send).not.toHaveBeenCalled();}finally{send.mockRestore();}
  expect(await getOutboundFile(other.id,a)).toMatchObject({contentAvailable:true,usage:{state:"unavailable",reasonCode:"FILE_MALICIOUS"}});
  await expect(retryAttachmentScan(other.id,"outbound",a,"fixture")).rejects.toMatchObject({code:"FILE_UNAVAILABLE"});
  const count=(await row(other.id)).attempt_count;await processAttachmentScan(other.id);expect((await row(other.id)).attempt_count).toBe(count);
 });
 it("enforces service ownership on query, reprocessing, download, send and deletion without exposing task facts",async()=>{
  const foreign=await uploadOutboundFile(b,"private.txt","text/plain",bytes,"mail.atlas.test");
  const context={params:Promise.resolve({id:foreign.id})};
  for(const response of [await fileAPI(request(`/files/${foreign.id}`),context),await reprocessAPI(request(`/files/${foreign.id}/reprocess`,"POST"),context),
   await downloadAPI(request(`/files/${foreign.id}/download`),context),await eraseAPI(request(`/files/${foreign.id}/content`,"DELETE"),context)]) expect(response.status).toBe(404);
  await expect(acceptMessage({identity,input:input([foreign.id]),idempotencyKey:createId("op")})).rejects.toMatchObject({code:"FILE_UNAVAILABLE"});
  expect(await row(foreign.id)).toMatchObject({attempt_count:0,status:"pending"});
 });
 it("retries temporary scanner failure finitely and resumes only after controlled audited recovery",async()=>{
  const uploaded=await file();
  for(let count=0;count<5;count++) {await processAttachmentScan(uploaded.id);await query("UPDATE attachment_safety SET next_attempt_at=now() WHERE resource_id=$1",[uploaded.id]);}
  expect(await row(uploaded.id)).toMatchObject({status:"unavailable",attempt_count:5,reason:"SCAN_NOT_CONFIGURED"});
  expect(await getOutboundFile(uploaded.id,a)).toMatchObject({usage:{state:"unavailable",recovery:"retry",canSend:false}});
  await processAttachmentScan(uploaded.id);expect((await row(uploaded.id)).attempt_count).toBe(5);
  await retryAttachmentScan(uploaded.id,"outbound",a,"fixture");await scanClean(uploaded.id);
  expect((await getOutboundFile(uploaded.id,a))!.usage.canSend).toBe(true);
  expect((await query("SELECT id FROM audit_logs WHERE action='attachment.reprocess' AND resource_id=$1",[uploaded.id])).rowCount).toBe(1);
 });
 it("fences duplicate, stale and late scan completion after content erasure",async()=>{
  const uploaded=await file();let release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const store=objectStore(),original=store.get.bind(store);
  const get=vi.spyOn(store,"get").mockImplementationOnce(async(...args)=>{const value=await original(...args);entered();await gate;return value;});
  const fixture=await scannerFixture();
  try {
   const work=processAttachmentScan(uploaded.id);await waiting;await processAttachmentScan(uploaded.id);
   expect((await row(uploaded.id)).attempt_count).toBe(1);
   await purgeContent("file",uploaded.id,a);release();await work;
   expect(await row(uploaded.id)).toMatchObject({status:"purged",lease_token:null});
   expect(await getOutboundFile(uploaded.id,a)).toMatchObject({contentAvailable:false,usage:{canSend:false,reasonCode:"FILE_CONTENT_PURGED"}});
   await processAttachmentScan(uploaded.id);await expect(retryAttachmentScan(uploaded.id,"outbound",a,"fixture")).rejects.toMatchObject({code:"FILE_UNAVAILABLE"});
  }finally{release();get.mockRestore();await fixture.close();}
 });
 it("terminates a crashed fifth claim and a permanently failed dispatch without silently resetting attempts",async()=>{
  const crashed=await file(),failed=await file();
  await query(`UPDATE attachment_safety SET status='scanning',attempt_count=5,policy_version='1',
    lease_token='expired',lease_expires_at=now()-interval '1 second' WHERE resource_id=$1`,[crashed.id]);
  const outbox=createId("out");
  await query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,status) VALUES($1,'attachment',$2,'attachment.scan.requested',$3,'failed')",[outbox,failed.id,{resourceId:failed.id}]);
  await query("UPDATE attachment_safety SET status='pending',policy_version='1',outbox_id=$2 WHERE resource_id=$1",[failed.id,outbox]);
  await scheduleAttachmentScans();await scheduleAttachmentScans();
  expect(await row(crashed.id)).toMatchObject({status:"unavailable",attempt_count:5,lease_token:null,reason:"SCAN_RETRIES_EXHAUSTED"});
  expect(await row(failed.id)).toMatchObject({status:"unavailable",attempt_count:5,reason:"SCAN_TASK_FAILED"});
  for(const id of [crashed.id,failed.id]) {
   expect(await getOutboundFile(id,a)).toMatchObject({usage:{processing:false,recovery:"retry",canSend:false}});
   await retryAttachmentScan(id,"outbound",a,"fixture");await scanClean(id);
   expect((await getOutboundFile(id,a))!.usage.canSend).toBe(true);
  }
 });
 it("recovers an actually killed scan process after its lease expires",async()=>{
  const uploaded=await file(),fixture=await scannerFixture(null);
  const child=fork(new URL("../fixtures/scan-child.ts",import.meta.url),[uploaded.id],{execArgv:["--import","tsx"],silent:true,env:{...process.env,CLAMAV_TIMEOUT_MS:"30000"}});
  try {
   let output="";child.stderr?.on("data",chunk=>{output+=chunk.toString();});
   let claimed=false;
   for(let i=0;i<100;i++) {if((await row(uploaded.id)).status==="scanning") {claimed=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
   expect(claimed,output).toBe(true);const token=(await row(uploaded.id)).lease_token;
   const exited=new Promise(resolve=>child.once("exit",resolve));child.kill("SIGKILL");await exited;
   await query("UPDATE attachment_safety SET lease_expires_at=now()-interval '1 second',next_attempt_at=now(),queued_until=NULL WHERE resource_id=$1",[uploaded.id]);
   await fixture.close();await scanClean(uploaded.id);
   expect(await row(uploaded.id)).toMatchObject({status:"clean",attempt_count:2,lease_token:null});expect(token).toBeTruthy();
  }finally{if(child.exitCode===null && child.signalCode===null) child.kill("SIGKILL");await fixture.close();}
 });
 it("rotates service scan dispatch fairly instead of putting one owner's batch ahead of others",async()=>{
  for(let i=0;i<12;i++) await file();
  const other=await uploadOutboundFile(b,"other.bin","application/octet-stream",bytes,"mail.atlas.test");
  await Promise.all([scheduleAttachmentScans(1),scheduleAttachmentScans(1)]);
  const scopes=Number((await query("SELECT count(*) AS count FROM attachment_scan_scopes")).rows[0].count);
  for(let i=0;i<scopes+2;i++) await scheduleAttachmentScans(1);
  const progress=(await query<{resource_id:string}>("SELECT resource_id FROM attachment_safety WHERE service_id=$1 AND queued_until>now()",[b])).rows;
  expect(progress).toHaveLength(1);
  expect((await query("SELECT resource_id FROM attachment_safety WHERE service_id=$1 AND queued_until>now()",[a])).rowCount).toBeLessThanOrEqual(1);
  expect(await row(other.id)).toBeDefined();
  const queued=await row(progress[0].resource_id);
  expect((await query("SELECT event_type,payload FROM outbox_events WHERE id=$1",[queued.outbox_id])).rows[0]).toMatchObject({event_type:"attachment.scan.requested",payload:{resourceId:progress[0].resource_id}});
 });
 it("invalidates prior policy proofs for admission and execution without automatically resending unknown submissions",async()=>{
  const uploaded=await file();await scanClean(uploaded.id);
  const accepted=await acceptMessage({identity,input:input([uploaded.id]),idempotencyKey:createId("op")});
  process.env.ATTACHMENT_POLICY_VERSION="2";
  try {
   await expect(acceptMessage({identity,input:input([uploaded.id]),idempotencyKey:createId("op")})).rejects.toMatchObject({code:"FILE_NOT_READY"});
   const send=vi.spyOn(providerRegistry("mock").sender,"send");try {await processDelivery(job(await submission(accepted.message.id)));expect(send).not.toHaveBeenCalled();}finally{send.mockRestore();}
  }finally{process.env.ATTACHMENT_POLICY_VERSION="1";}
  const pending=await acceptMessage({identity,input:input([uploaded.id]),idempotencyKey:createId("op")});
  const send=vi.spyOn(providerRegistry("mock").sender,"send").mockResolvedValue({outcome:"unknown",reason:"controlled fixture"});
  try {
   const id=await submission(pending.message.id);await processDelivery(job(id));
   await retryAttachmentScan(uploaded.id,"outbound",a,"fixture");await scanClean(uploaded.id);await processDelivery(job(id));
   expect(send).toHaveBeenCalledTimes(1);expect((await query("SELECT status FROM submissions WHERE id=$1",[id])).rows[0].status).toBe("unknown");
  }finally{send.mockRestore();}
 });
 it("keeps canceled sends canceled after attachment reprocessing",async()=>{
  const uploaded=await file();await scanClean(uploaded.id);const accepted=await acceptMessage({identity,input:input([uploaded.id]),idempotencyKey:createId("op")});
  await cancelMessage(accepted.message.id,a);await retryAttachmentScan(uploaded.id,"outbound",a,"fixture");await scanClean(uploaded.id);
  const send=vi.spyOn(providerRegistry("mock").sender,"send");try{await processDelivery(job(await submission(accepted.message.id)));expect(send).not.toHaveBeenCalled();}finally{send.mockRestore();}
 });
 it("quarantines changed stored bytes before sending and never applies another object's proof",async()=>{
  const uploaded=await file();await scanClean(uploaded.id);
  const accepted=await acceptMessage({identity,input:input([uploaded.id]),idempotencyKey:createId("op")});
  const key=(await query<{object_key:string}>("SELECT object_key FROM outbound_files WHERE id=$1",[uploaded.id])).rows[0].object_key;
  await objectStore().put(key,Buffer.from("different fixture bytes"),"application/octet-stream");
  const send=vi.spyOn(providerRegistry("mock").sender,"send");try{await processDelivery(job(await submission(accepted.message.id)));expect(send).not.toHaveBeenCalled();}finally{send.mockRestore();}
  expect(await getOutboundFile(uploaded.id,a)).toMatchObject({usage:{canSend:false,reasonCode:"FILE_INTEGRITY_FAILED",safetyState:"blocked"}});
  await expect(downloadAttachment("outbound",uploaded.id,a)).rejects.toMatchObject({code:"FILE_UNAVAILABLE"});
 });
 it("fences a stale clean result after a newer claim already detected malware",async()=>{
  const uploaded=await file(),clean=await scannerFixture();
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
  const store=objectStore(),original=store.get.bind(store);
  const get=vi.spyOn(store,"get").mockImplementationOnce(async(...args)=>{const bytes=await original(...args);entered();await gate;return bytes;});
  try {
   const stale=processAttachmentScan(uploaded.id);await waiting;
   await query("UPDATE attachment_safety SET lease_expires_at=now()-interval '1 second',next_attempt_at=now() WHERE resource_id=$1",[uploaded.id]);
   const malicious=await scannerFixture("stream: Fixture.Bad FOUND\0");
   try{await processAttachmentScan(uploaded.id);}finally{await malicious.close();}
   release();await stale;
   expect(await row(uploaded.id)).toMatchObject({status:"malicious",attempt_count:2});
  }finally{release();get.mockRestore();await clean.close();}
 });
 it("linearizes download and erase, and denies every later read",async()=>{
  const uploaded=await file();await scanClean(uploaded.id);
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
  const store=objectStore(),original=store.get.bind(store);
  const get=vi.spyOn(store,"get").mockImplementationOnce(async(...args)=>{const bytes=await original(...args);entered();await gate;return bytes;});
  try {
   const download=downloadAttachment("outbound",uploaded.id,a);await waiting;
   let erased=false;const erasure=purgeContent("file",uploaded.id,a).then(value=>{erased=true;return value;});
   await new Promise(resolve=>setTimeout(resolve,20));expect(erased).toBe(false);
   release();expect(await (await download)!.text()).toBe(bytes.toString());await erasure;
   await expect(downloadAttachment("outbound",uploaded.id,a)).rejects.toMatchObject({code:"FILE_UNAVAILABLE"});
  }finally{release();get.mockRestore();}
 });
 it("keeps the provider boundary protected from concurrent file reprocessing",async()=>{
  const uploaded=await file();await scanClean(uploaded.id);const accepted=await acceptMessage({identity,input:input([uploaded.id]),idempotencyKey:createId("op")});
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
  const send=vi.spyOn(providerRegistry("mock").sender,"send").mockImplementationOnce(async()=>{entered();await gate;return {outcome:"accepted",externalMessageId:createId("external")};});
  try {
   const work=processDelivery(job(await submission(accepted.message.id)));await waiting;
   let reprocessed=false;const change=retryAttachmentScan(uploaded.id,"outbound",a,"fixture").then(()=>{reprocessed=true;});
   await new Promise(resolve=>setTimeout(resolve,20));expect(reprocessed).toBe(false);
   release();await work;await change;expect(send).toHaveBeenCalledTimes(1);
   expect((await getOutboundFile(uploaded.id,a))!.usage.canSend).toBe(false);
  }finally{release();send.mockRestore();}
 });
 it("rechecks wall-clock submission expiry after slow storage preparation before any provider operation",async()=>{
  const uploaded=await file();await scanClean(uploaded.id);
  const accepted=await acceptMessage({identity,input:input([uploaded.id]),idempotencyKey:createId("op")}),id=await submission(accepted.message.id);
  const store=objectStore(),original=store.get.bind(store);
  const get=vi.spyOn(store,"get").mockImplementationOnce(async(...args)=>{
   const value=await original(...args);
   await query("UPDATE submission_attempts SET submission_deadline_at=clock_timestamp()-interval '1 second' WHERE submission_id=$1",[id]);
   return value;
  });
  const send=vi.spyOn(providerRegistry("mock").sender,"send");
  try {
   await processDelivery(job(id));expect(send).not.toHaveBeenCalled();
   expect((await query("SELECT status,outcome_determinate,error_code FROM submission_attempts WHERE submission_id=$1",[id])).rows[0])
    .toMatchObject({status:"failed",outcome_determinate:true,error_code:"LOCAL_PREPARATION_FAILED"});
  }finally{get.mockRestore();send.mockRestore();}
 });
 it("rechecks the active policy after attachment storage I/O",async()=>{
  const uploaded=await file();await scanClean(uploaded.id);
  const accepted=await acceptMessage({identity,input:input([uploaded.id]),idempotencyKey:createId("op")});
  const store=objectStore(),original=store.get.bind(store);
  const get=vi.spyOn(store,"get").mockImplementationOnce(async(...args)=>{const value=await original(...args);process.env.ATTACHMENT_POLICY_VERSION="2";return value;});
  const send=vi.spyOn(providerRegistry("mock").sender,"send");
  try{await processDelivery(job(await submission(accepted.message.id)));expect(send).not.toHaveBeenCalled();}
  finally{process.env.ATTACHMENT_POLICY_VERSION="1";get.mockRestore();send.mockRestore();}
 });
 it("executes durable scheduler/outbox jobs on the existing PostgreSQL attachment queue",async()=>{
  const uploaded=await file(),fixture=await scannerFixture();
  const worker=createQueueWorker(ATTACHMENT_QUEUE,task=>processAttachmentScan(task.data.resourceId),4);
  await worker.waitUntilReady();const running=worker.run();
  try {
   for(let index=0;index<100 && (await row(uploaded.id)).status!=="clean";index++) {
    await scheduleAttachmentScans(16);await dispatchOutboxBatch(100);await new Promise(resolve=>setTimeout(resolve,20));
   }
   expect((await row(uploaded.id)).status).toBe("clean");
  }finally{await worker.close();await running;await closeQueues();await fixture.close();}
 });
 it("retains inbound inline bytes privately while processing and applies the same download/reprocessing policy",async()=>{
  const rawId=createId("raw");
  await query("INSERT INTO raw_provider_events(id,provider_account_id,webhook_endpoint_id,native_type,signature_valid,replay_valid,headers,processed_at) VALUES($1,'pa_mock','pwe_mock','inbound',true,true,'{}',now())",[rawId]);
  const externalId=createId("external");
  await persistInbound({providerAccountId:"pa_mock",webhookEndpointId:"pwe_mock",rawEventId:rawId,message:{externalMessageId:externalId,
   from:"author@example.test",to:[`${tag}@mail.atlas.test`],cc:[],bcc:[],envelopeRecipients:[`${tag}@mail.atlas.test`],subject:"body",text:"body",receivedAt:new Date(),
   attachments:[{fileName:"inline.png",contentType:"image/png",content:bytes,contentId:"inline-id"}]}});
  const id=(await query<{id:string}>("SELECT id FROM inbound_messages WHERE external_message_id=$1 AND service_id=$2",[externalId,a])).rows[0].id;
  const attachment=(await getInboundMessage(id,a))!.attachments[0];
  expect(attachment).toMatchObject({contentAvailable:true,contentId:"inline-id",usage:{canDownload:false}});
  await expect(getInboundAttachment(id,attachment.id,a)).rejects.toMatchObject({code:"FILE_NOT_READY"});
  expect(await getInboundAttachment(id,attachment.id,b)).toBeNull();
  const foreign=await reprocessInboundAPI(request(`/inbound-messages/${id}/attachments/${attachment.id}/reprocess`,"POST"),{params:Promise.resolve({id,attachmentId:createId("other")})});expect(foreign.status).toBe(404);
  await scanClean(attachment.id);expect(await (await getInboundAttachment(id,attachment.id,a))!.text()).toBe(bytes.toString());
  await purgeContent("inbound",id,a);await processAttachmentScan(attachment.id);expect((await row(attachment.id)).status).toBe("purged");
 });
});
