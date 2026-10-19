import { scanClean } from "../helpers/scanner";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { createMessageSchema } from "@/lib/contracts";
import { query, db } from "@/platform/database";
import { createId } from "@/platform/ids";
import { persistInbound } from "@/modules/inbound/public";
import { listInboundChanges, InboundCursorError } from "@/modules/inbound/public";
import { getInboundMessage, listInboundMessages, getInboundAttachment } from "@/modules/inbound/public";
import { purgeContent } from "@/modules/identity/public";
import { discoverMail } from "@/modules/identity/public";
import { rotateServiceCredential, revokeServiceCredential } from "@/modules/identity/public";
import { replayDeadLetters } from "@/modules/callbacks/public";
import { terminateRawEvent, replayRawEvent } from "@/modules/inbound/public";
import { terminateCallback, deliverCallback } from "@/modules/callbacks/public";
import { authenticateService } from "@/server/auth";
import { hashApiKey } from "@/platform/crypto/hash";
import { sealSecret } from "@/platform/crypto/envelope";
import { objectStore } from "@/platform/storage/object-store";
import { runRetention } from "@/platform/retention/public";
import { uploadOutboundFile, resolveOutboundAttachments } from "@/modules/attachments/public";
import { prepareSubmission, markAccepted } from "@/modules/outbound/public";
import { getMessageAttempts } from "@/modules/outbound/public";
import { processRawProviderEvent } from "@/modules/outbound/public";
import { acceptMessage } from "@/modules/outbound/public";
import { GET as changesAPI } from "@/app/api/v1/inbound-changes/route";
import { DELETE as purgeAPI } from "@/app/api/v1/inbound-messages/[id]/content/route";
import type { CanonicalInboundMessage } from "@/integrations/providers/contracts";

const tag=createId("recovery"), a=`svc_a_${tag}`,b=`svc_b_${tag}`,c=`svc_c_${tag}`,domain=`${tag.replaceAll("_","")}.test`,domainId=`sd_${tag}`;
const callback=`cb_${tag}`,credential=`cred_${tag}`,oldKey=`envoy_test_${tag}`;
const identity={serviceId:a,serviceName:"A",rateLimitPerMinute:600};
const rawIds:string[]=[];
const make=(extra:Partial<CanonicalInboundMessage>={}):CanonicalInboundMessage=>({externalMessageId:createId("external"),from:"author@example.net",to:[`help@${domain}`],cc:[],bcc:[],envelopeRecipients:[`help@${domain}`],subject:"Private subject",text:"private body",receivedAt:new Date("1900-01-01"),attachments:[],...extra});
const persist=(message:CanonicalInboundMessage,rawEventId:string|null=null)=>persistInbound({providerAccountId:"pa_mock",webhookEndpointId:"pwe_mock",rawEventId:rawEventId!,message});
const request=(key=oldKey,path="/api/v1/inbound-changes",method="GET")=>new Request(`https://envoy.test${path}`,{method,headers:{authorization:`Bearer ${key}`}});
async function scanning(service=a) {
 const id=createId("inb");
 await query(`INSERT INTO inbound_messages(id,service_id,provider_account_id,external_message_id,delivery_scope,from_email,to_emails,subject,status,envelope_recipients) VALUES($1,$2,'pa_mock',$1,$2,'a@example.net','{}','test','scanning',ARRAY[$3])`,[id,service,`help@${domain}`]);
 return id;
}
async function ready(service=a) { const id=await scanning(service);await query("UPDATE inbound_messages SET status='ready',ready_at=clock_timestamp() WHERE id=$1",[id]);return id; }

beforeAll(async()=>{
 for (const service of [a,b,c]) await query("INSERT INTO services(id,name) VALUES($1,$1)",[service]);
 await query("INSERT INTO sending_domains(id,domain) VALUES($1,$2)",[domainId,domain]);
 await query("INSERT INTO domain_inbound_sources(sending_domain_id,provider_account_id) VALUES($1,'pa_mock')",[domainId]);
 await query("INSERT INTO service_credentials(id,service_id,key_prefix,key_hash) VALUES($1,$2,'test',$3)",[credential,a,hashApiKey(oldKey)]);
 const sealed=sealSecret({secret:"test-recovery-callback"},callback,1);
 await query("INSERT INTO callback_endpoints(id,service_id,name,url,secret_ciphertext,encrypted_dek,key_version,subscribed_events) VALUES($1,$2,'recovery','https://callback.test/events',$3,$4,$5,ARRAY['inbound.received'])",[callback,a,sealed.secretCiphertext,sealed.encryptedDek,sealed.keyVersion]);
 await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status) VALUES($1,$2,'pa_mock','verified')",[`pi_${tag}`,domainId]);
 for(const service of [a,b,c]) await query("INSERT INTO service_domain_bindings(id,service_id,sending_domain_id,receive_enabled,outbound_provider_identity_id) VALUES($1,$2,$3,true,$4)",[createId('sdb'),service,domainId,service===a?`pi_${tag}`:null]);

});
afterAll(async()=>{
 vi.restoreAllMocks();vi.unstubAllEnvs();
 const objects=(await query<{object_key:string}>("SELECT a.object_key FROM inbound_attachments a JOIN inbound_messages i ON i.id=a.inbound_message_id WHERE i.service_id=ANY($1)",[[a,b,c]])).rows;
 for (const file of objects) await objectStore().delete(file.object_key);
 for(const file of (await query<{object_key:string}>("SELECT object_key FROM outbound_files WHERE service_id=ANY($1)",[[a,b,c]])).rows) await objectStore().delete(file.object_key);
 await query("DELETE FROM callback_deliveries WHERE endpoint_id=$1",[callback]);
 await query("DELETE FROM inbound_receipts WHERE external_message_id IN (SELECT external_message_id FROM inbound_messages WHERE service_id=ANY($1))",[[a,b,c]]);
 await query("DELETE FROM inbound_messages WHERE service_id=ANY($1)",[[a,b,c]]);
 await query("DELETE FROM messages WHERE service_id=ANY($1)",[[a,b,c]]);
 await query("DELETE FROM outbound_files WHERE service_id=ANY($1)",[[a,b,c]]);
 await query("DELETE FROM raw_provider_events WHERE id=ANY($1)",[rawIds]);
 await query("DELETE FROM services WHERE id=ANY($1)",[[a,b,c]]);await query("DELETE FROM sending_domains WHERE id=$1",[domainId]);
 await db().end();
});

describe("trusted inbound clocks and durable recovery",()=>{
 it.each([new Date("1900-01-01"),new Date("2200-01-01"),new Date(NaN),undefined])("never lets author Date control paging or retention (%s)",async authorDate=>{
  const rawId=createId("raw");rawIds.push(rawId);
  await query("INSERT INTO raw_provider_events(id,provider_account_id,webhook_endpoint_id,native_type,signature_valid,replay_valid,headers,received_at) VALUES($1,'pa_mock','pwe_mock','inbound',true,true,'{}',now()-interval '3 days')",[rawId]);
  const id=await persist(make({authorDate}),rawId);
  const item=(await getInboundMessage(id,a))!;
  expect(item.authorDate).toBe(authorDate && Number.isFinite(authorDate.getTime()) ? authorDate.toISOString() : null);
  expect(Date.parse(item.ingressReceivedAt!)).toBeLessThan(Date.now()-2*86400000);
  expect(Date.parse(item.receivedAt)).toBeGreaterThan(Date.now()-10000);
  expect(Date.parse(item.readyAt!)).toBeGreaterThan(Date.parse(item.ingressReceivedAt!));
  await query("UPDATE callback_deliveries SET status='delivered' WHERE inbound_message_id=$1",[id]);
  const result=await runRetention({apply:true,batchSize:100,days:{inbound:1}},{put:vi.fn(),get:vi.fn(),delete:vi.fn()});
  expect(result.inbound.applied).toBe(0);
  expect((await listInboundMessages(a,{limit:100})).data.find(row=>row.id===id)?.receivedAt).toBe(item.receivedAt);
 });
 it("publishes availability after a delayed scan, even after consumers reached the previous tail",async()=>{
  const before=await listInboundChanges(a,100);
  const id=await scanning();
  await query("UPDATE inbound_messages SET created_at=now()-interval '10 days',received_at=now()-interval '10 years' WHERE id=$1",[id]);
  expect((await listInboundChanges(a,100,before.nextCursor)).data).toEqual([]);
  await query("UPDATE inbound_messages SET status='ready',ready_at=clock_timestamp() WHERE id=$1",[id]);
  const page=await listInboundChanges(a,1,before.nextCursor);
  expect(page.data.map(e=>[e.inboundMessageId,e.type])).toEqual([[id,"inbound.available"]]);
  expect(await listInboundChanges(a,1,before.nextCursor)).toEqual(page);
  expect((await listInboundChanges(a,1,page.nextCursor)).data).toEqual([]);
  await runRetention({apply:true,batchSize:100,days:{inbound:1}},{put:vi.fn(),get:vi.fn(),delete:vi.fn()});
  expect((await getInboundMessage(id,a))!.contentPurgedAt).toBeNull();
 });
 it("serializes cursor publication through commit and rollback without late lower positions",async()=>{
  const before=await listInboundChanges(c,100);
  const first=await scanning(c),second=await scanning(c);
  const x=await db().connect(),y=await db().connect();
  try {
   await x.query("BEGIN");await y.query("BEGIN");
   await x.query("UPDATE inbound_messages SET status='ready' WHERE id=$1",[first]);
   let secondDone=false;
   const secondWrite=y.query("UPDATE inbound_messages SET status='ready' WHERE id=$1",[second]).then(()=>{secondDone=true;});
   await new Promise(resolve=>setTimeout(resolve,30));expect(secondDone).toBe(false);
   await x.query("ROLLBACK");await secondWrite;await y.query("COMMIT");
   const page=await listInboundChanges(c,1,before.nextCursor);
   expect(page.data.map(e=>e.inboundMessageId)).toEqual([second]);
   await query("UPDATE inbound_messages SET status='ready' WHERE id=$1",[first]);
   const late=await listInboundChanges(c,1,page.nextCursor);
   expect(late.data.map(e=>e.inboundMessageId)).toEqual([first]);
   expect(late.hasMore).toBe(false);
   expect((await listInboundChanges(a,100)).data.some(e=>e.inboundMessageId===first)).toBe(false);
   await expect(listInboundChanges(a,10,page.nextCursor)).rejects.toMatchObject({code:"INVALID_INBOUND_CURSOR"});
  } finally {await x.query("ROLLBACK");await y.query("ROLLBACK");x.release();y.release();}
 });
 it("pages numerically beyond nine positions without skipping or duplicating changes",async()=>{
  const start=await listInboundChanges(c,100);
  const expected=[];for(let index=0;index<25;index++) expected.push(await ready(c));
  const ids=[];let cursor=start.nextCursor;
  for(let page=0;page<10;page++) { const result=await listInboundChanges(c,4,cursor);ids.push(...result.data.map(row=>row.inboundMessageId));cursor=result.nextCursor;if(!result.hasMore) break; }
  expect(ids).toEqual(expected);
 });
 it("rejects malformed JSON cursor shapes with a stable client error",async()=>{
  for (const value of [null,[],1,"cursor",{}, {service:a,position:"-1"}]) {
   const cursor=Buffer.from(JSON.stringify(value)).toString("base64url");
   const response=await changesAPI(request(oldKey,`/api/v1/inbound-changes?cursor=${cursor}`));
   expect(response.status).toBe(400);expect(await response.json()).toMatchObject({code:"INVALID_INBOUND_CURSOR"});
  }
 });
 it("bounds each page while appends continue and reports retention gaps explicitly",async()=>{
  const before=await listInboundChanges(c,100);
  const one=await ready(c),two=await ready(c);
  const page=await listInboundChanges(c,1,before.nextCursor);expect(page.hasMore).toBe(true);
  const three=await ready(c);
  const next=await listInboundChanges(c,1,page.nextCursor),last=await listInboundChanges(c,1,next.nextCursor);
  expect([...page.data,...next.data,...last.data].map(e=>e.inboundMessageId)).toEqual([one,two,three]);
  await query("UPDATE inbound_changes SET recorded_at=now()-interval '91 days' WHERE service_id=$1",[c]);
  await runRetention({apply:true,batchSize:100,days:{}},{put:vi.fn(),get:vi.fn(),delete:vi.fn()});
  await expect(listInboundChanges(c,100,before.nextCursor)).rejects.toBeInstanceOf(InboundCursorError);
  expect((await listInboundChanges(c,10)).retention.historyTruncated).toBe(true);
  // Service API maps gap to a stable 410, without changing outbound /events.
  const oldA=await listInboundChanges(a,100);
  await query("UPDATE inbound_changes SET recorded_at=now()-interval '91 days' WHERE service_id=$1",[a]);
  await runRetention({apply:true,batchSize:100,days:{}},{put:vi.fn(),get:vi.fn(),delete:vi.fn()});
  const expired=await changesAPI(request(oldKey,`/api/v1/inbound-changes?cursor=${encodeURIComponent(oldA.retention.earliestCursor)}`));
  expect(expired.status).toBe(410);expect(await expired.json()).toMatchObject({code:"INBOUND_CURSOR_EXPIRED",errors:{gap:true}});
 });
});

describe("independent recovery, notification binding and lifecycle",()=>{
 it("continues other copies after a failure and freezes receiving bindings across retries",async()=>{
  await query("UPDATE service_domain_bindings SET receive_enabled=false WHERE service_id=$1 AND sending_domain_id=$2",[c,domainId]);
  const message=make({envelopeRecipients:[`help@${domain}`,`other@${domain}`],attachments:[{fileName:"private.txt",contentType:"text/plain",content:Buffer.from("bytes")}]});
  const store=objectStore(),put=vi.spyOn(store,"put");put.mockRejectedValueOnce(new Error("temporary storage outage"));
  try {
   await expect(persist(message)).rejects.toThrow("temporary storage outage");
   expect((await query("SELECT service_id,status FROM inbound_messages WHERE external_message_id=$1 AND status='ready'",[message.externalMessageId])).rows).toHaveLength(1);
   await query("UPDATE service_domain_bindings SET receive_enabled=true WHERE service_id=$1 AND sending_domain_id=$2",[c,domainId]);
   await persist(message);await persist(message);
   const copies=(await query<{id:string;service_id:string}>("SELECT id,service_id FROM inbound_messages WHERE external_message_id=$1",[message.externalMessageId])).rows;
   expect(copies.map(r=>r.service_id).sort()).toEqual([a,b].sort());
   expect((await query("SELECT id FROM inbound_attachments WHERE inbound_message_id=ANY($1)",[copies.map(c=>c.id)])).rowCount).toBe(2);
  } finally {put.mockRestore();await query("UPDATE service_domain_bindings SET receive_enabled=true WHERE service_id=$1 AND sending_domain_id=$2",[c,domainId]);}
 });
 it("distinguishes polling, valid callbacks, disabled/misowned bindings and missing subscriptions",async()=>{
  expect((await discoverMail({...identity,serviceId:b})).domains[0].notification).toMatchObject({mode:"polling",state:"configured"});
  expect((await discoverMail(identity)).domains[0].notification).toMatchObject({mode:"callback_and_polling",state:"configured"});
  await query("UPDATE callback_endpoints SET subscribed_events='{}' WHERE id=$1",[callback]);
  try {
   expect((await discoverMail(identity)).domains[0].notification.reasonCodes).toContain("CALLBACK_EVENT_NOT_SUBSCRIBED");
   const cbId=createId("cbx");
   await query("INSERT INTO callback_deliveries(id,endpoint_id,event_type,payload) VALUES($1,$2,'inbound.received','{}')",[cbId,callback]);
   await deliverCallback(cbId);expect((await query("SELECT status FROM callback_deliveries WHERE id=$1",[cbId])).rows[0].status).toBe("dead_letter");
   expect(await replayDeadLetters("test",{deliveryId:cbId})).toBe(0);
  } finally {await query("UPDATE callback_endpoints SET subscribed_events=ARRAY['inbound.received'] WHERE id=$1",[callback]);}
  await query("UPDATE callback_endpoints SET status='disabled' WHERE id=$1",[callback]);
  try {expect((await discoverMail(identity)).domains[0].notification.reasonCodes).toContain("CALLBACK_DISABLED");}
  finally {await query("UPDATE callback_endpoints SET status='active' WHERE id=$1",[callback]);}
 });
 it("purges one private copy idempotently, emits a change and never resurrects it through replay",async()=>{
  const message=make({envelopeRecipients:[`help@${domain}`,`other@${domain}`],rawMime:Buffer.from("private MIME"),attachments:[{fileName:"secret.txt",contentType:"text/plain",content:Buffer.from("secret")}]});
  await persist(message);
  const copies=(await query<{id:string;service_id:string}>("SELECT id,service_id FROM inbound_messages WHERE external_message_id=$1",[message.externalMessageId])).rows;
  const own=copies.find(row=>row.service_id===a)!.id,other=copies.find(row=>row.service_id===b)!.id;
  const file=(await getInboundMessage(own,a))!.attachments[0];
  expect(await purgeContent("inbound",own,b)).toBeNull();
  const tail=await listInboundChanges(a,100);
  const purged=await purgeContent("inbound",own,a);expect(await purgeContent("inbound",own,a)).toEqual(purged);
  expect(await getInboundAttachment(own,file.id,a)).toBeNull();
  expect((await getInboundMessage(other,b))!.text).toBe("private body");
  await persist(message);
  expect((await getInboundMessage(own,a))!).toMatchObject({subject:"",text:null,contentPurgedAt:expect.any(String)});
  expect((await listInboundChanges(a,100,tail.nextCursor)).data.map(e=>[e.type,e.inboundMessageId])).toEqual([["inbound.content_purged",own]]);
  const callbacks=(await query<{id:string;status:string;payload:unknown}>("SELECT id,status,payload FROM callback_deliveries WHERE inbound_message_id=$1",[own])).rows;
  expect(callbacks).toHaveLength(1);expect(callbacks[0]).toMatchObject({status:"terminated",payload:{}});
  expect(await replayDeadLetters("test",{deliveryId:callbacks[0].id})).toBe(0);
  const api=await purgeAPI(request(oldKey,`/api/v1/inbound-messages/${other}/content`,"DELETE"),{params:Promise.resolve({id:other})});expect(api.status).toBe(404);
 });
 it("blocks scanning and in-flight callbacks; explicitly terminates dead letters without pretending delivery",async()=>{
  const pending=await scanning();await expect(purgeContent("inbound",pending,a)).rejects.toMatchObject({code:"CONTENT_BUSY"});
  await query("UPDATE inbound_messages SET status='rejected' WHERE id=$1",[pending]);
  const id=await persist(make());const cbId=(await query<{id:string}>("SELECT id FROM callback_deliveries WHERE inbound_message_id=$1",[id])).rows[0].id;
  await query("UPDATE callback_deliveries SET status='delivering' WHERE id=$1",[cbId]);
  await expect(purgeContent("inbound",id,a)).rejects.toMatchObject({code:"CONTENT_BUSY"});
  await query("UPDATE callback_deliveries SET status='dead_letter' WHERE id=$1",[cbId]);
  await terminateCallback(cbId,"test");
  expect((await query("SELECT status,delivered_at,terminated_at FROM callback_deliveries WHERE id=$1",[cbId])).rows[0]).toMatchObject({status:"terminated",delivered_at:null,terminated_at:expect.any(Date)});
  expect(await replayDeadLetters("test",{deliveryId:cbId})).toBe(0);
  await query("UPDATE inbound_messages SET created_at=now()-interval '5 days',ready_at=now()-interval '5 days' WHERE id=$1",[id]);
  const result=await runRetention({apply:true,batchSize:100,days:{inbound:1}},{put:vi.fn(),get:vi.fn(),delete:vi.fn()});expect(result.inbound.applied).toBeGreaterThanOrEqual(1);
 });
 it("retains shared raw evidence until the last authorized copy is erased and refuses raw replay",async()=>{
  const rawId=createId("raw");rawIds.push(rawId);
  await query("INSERT INTO raw_provider_events(id,provider_account_id,webhook_endpoint_id,native_type,signature_valid,replay_valid,headers,raw_body,verification,processed_at) VALUES($1,'pa_mock','pwe_mock','inbound',true,true,'{}',$2,$3,now())",[rawId,Buffer.from("sensitive"),{valid:true,replaySafe:true,nativeType:"inbound.received",parsed:{}}]);
  const message=make({envelopeRecipients:[`help@${domain}`,`other@${domain}`]});await persist(message,rawId);
  const copies=(await query<{id:string;service_id:string}>("SELECT id,service_id FROM inbound_messages WHERE raw_provider_event_id=$1",[rawId])).rows;
  await purgeContent("inbound",copies.find(row=>row.service_id===a)!.id,a);
  expect((await query("SELECT raw_body,content_purged_at FROM raw_provider_events WHERE id=$1",[rawId])).rows[0]).toMatchObject({content_purged_at:null,raw_body:Buffer.from("sensitive")});
  await purgeContent("inbound",copies.find(row=>row.service_id===b)!.id,b);
  expect((await query("SELECT content_purged_at FROM raw_provider_events WHERE id=$1",[rawId])).rows[0].content_purged_at).toBeNull();
  await purgeContent("inbound",copies.find(row=>row.service_id===c)!.id,c);
  expect((await query("SELECT raw_body,verification,content_purged_at FROM raw_provider_events WHERE id=$1",[rawId])).rows[0]).toMatchObject({raw_body:null,verification:{},content_purged_at:expect.any(Date)});
  await expect(replayRawEvent(rawId,"test")).rejects.toThrow("expired");await processRawProviderEvent(rawId);
  await persist(message,rawId);
  expect((await query("SELECT id FROM inbound_messages WHERE raw_provider_event_id=$1 AND content_purged_at IS NULL",[rawId])).rowCount).toBe(0);
 });
 it("terminates exhausted raw recovery without restoring unfinished content or marking processing successful",async()=>{
  const rawId=createId("raw");rawIds.push(rawId);
  await query("INSERT INTO raw_provider_events(id,provider_account_id,webhook_endpoint_id,native_type,signature_valid,replay_valid,headers,processing_attempt_count,processing_error,next_attempt_at) VALUES($1,'pa_mock','pwe_mock','inbound',true,true,'{}',20,'storage error',now())",[rawId]);
  const message=make({rawMime:Buffer.from("blocked raw")});
  const put=vi.spyOn(objectStore(),"put").mockRejectedValueOnce(new Error("outage"));
  try {await expect(persist(message,rawId)).rejects.toThrow("outage");}finally{put.mockRestore();}
  await terminateRawEvent(rawId,"test");
  expect((await query("SELECT processed_at,terminated_at FROM raw_provider_events WHERE id=$1",[rawId])).rows[0]).toMatchObject({processed_at:null,terminated_at:expect.any(Date)});
  const copy=(await query<{id:string}>("SELECT id FROM inbound_messages WHERE raw_provider_event_id=$1 AND rejection_reason='INBOUND_PROCESSING_TERMINATED'",[rawId])).rows[0];expect(copy).toBeDefined();
  await expect(replayRawEvent(rawId,"test")).rejects.toThrow();await expect(persist(message,rawId)).rejects.toThrow("INBOUND_RECEIPT_TERMINATED");
  await purgeContent("inbound",copy.id,a);
 });
 it("protects shared outbound files and persists confirmed/unknown RFC facts per attempt",async()=>{
  const file=await uploadOutboundFile(a,"private.txt","text/plain",Buffer.from("retained bytes"),domain);
  await expect(resolveOutboundAttachments(b,[{fileId:file.id,disposition:"attachment"}])).rejects.toMatchObject({code:"FILE_UNAVAILABLE"});
  await scanClean(file.id);
  const input=createMessageSchema.parse({from:{email:`help@${domain}`},to:[{email:"recipient@example.net"}],subject:"test",text:"body",attachments:[{fileId:file.id,disposition:"attachment"}]});
  const first=await acceptMessage({identity,input,idempotencyKey:createId("shared")}),second=await acceptMessage({identity,input,idempotencyKey:createId("shared")});
  await expect(purgeContent("file",file.id,a)).rejects.toMatchObject({code:"CONTENT_SHARED"});
  expect(await purgeContent("file",file.id,b)).toBeNull();
  const submission=(await query<{id:string}>("SELECT id FROM submissions WHERE message_id=$1",[first.message.id])).rows[0].id;
  const prepared=await prepareSubmission(submission);if(!prepared || "reconcileAttemptId" in prepared) throw new Error("Expected prepared attempt");
  await markAccepted(prepared.attemptId,"external-provider-token",{},"<confirmed@example.test>");
  const unknownId=createId("attempt");
  await query("INSERT INTO submission_attempts(id,submission_id,attempt_number,provider_account_id,provider_identity_id,routing_snapshot,request_fingerprint,status) VALUES($1,$2,2,'pa_mock',$3,'{}','fingerprint','unknown')",[unknownId,submission,`pi_${tag}`]);
  const attempts=(await getMessageAttempts(first.message.id,a,{limit:100}))!.data;
  expect(attempts.find(row=>row.id===prepared.attemptId)).toMatchObject({rfcMessageId:"<confirmed@example.test>",rfcMessageIdStatus:"confirmed"});
  expect(attempts.find(row=>row.id===unknownId)).toMatchObject({rfcMessageId:null,rfcMessageIdStatus:"unknown"});
  expect(await getMessageAttempts(first.message.id,b,{limit:100})).toBeNull();
  await query("UPDATE deliveries SET lifecycle_status='canceled' WHERE message_id=ANY($1)",[[first.message.id,second.message.id]]);
  await expect(purgeContent("message",first.message.id,a)).rejects.toMatchObject({code:"CONTENT_BUSY"});
  await query("UPDATE submission_attempts SET status='failed' WHERE id=$1",[unknownId]);
  await purgeContent("message",first.message.id,a);
  expect((await query("SELECT content_purged_at FROM outbound_files WHERE id=$1",[file.id])).rows[0].content_purged_at).toBeNull();
  await purgeContent("message",second.message.id,a);
  expect((await query("SELECT content_purged_at FROM outbound_files WHERE id=$1",[file.id])).rows[0].content_purged_at).toBeInstanceOf(Date);
  await expect(resolveOutboundAttachments(a,[{fileId:file.id,disposition:"attachment"}])).rejects.toMatchObject({code:"FILE_UNAVAILABLE"});
 });
 it("plans actual discovery queries without an authorization or evidence cache",async()=>{
  const spy=vi.spyOn(db(),"query");let calls:unknown[][]=[];
  try {await discoverMail(identity);calls=spy.mock.calls.map(call=>Array.from(call));}finally{spy.mockRestore();}
  const timings=[];
  for(const [sql,values] of calls) {
   if(typeof sql!=="string" || !sql.trimStart().startsWith("SELECT")) continue;
   const plan=(await query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,values as unknown[])).rows[0]["QUERY PLAN"][0];
   expect(plan["Execution Time"]).toBeGreaterThanOrEqual(0);timings.push(plan["Execution Time"]);
  }
  expect(timings).toHaveLength(2);
  console.info("Isolated discovery query execution times (ms; not a production benchmark)",timings);
 });
 it("overlaps credential rotation with stable service history and idempotency, then revokes explicitly",async()=>{
  const next=await rotateServiceCredential(credential,"test");expect(next.id).not.toBe(credential);
  expect(Date.parse(next.overlapUntil)-Date.now()).toBeGreaterThan(23*60*60*1000);
  expect(Date.parse(next.overlapUntil)-Date.now()).toBeLessThanOrEqual(24*60*60*1000);
  expect((await authenticateService(request(next.key)))?.serviceId).toBe(a);
  expect((await authenticateService(request(oldKey)))?.serviceId).toBe(a);
  const mail=createMessageSchema.parse({from:{email:`help@${domain}`},to:[{email:"recipient@example.net"}],subject:"test",text:"body"});
  const first=await acceptMessage({identity,input:mail,idempotencyKey:`rotation_${tag}`});
  const newIdentity=(await authenticateService(request(next.key)))!;
  expect((await acceptMessage({identity:newIdentity,input:mail,idempotencyKey:`rotation_${tag}`})).message).toEqual(first.message);
  await expect(purgeContent("message",first.message.id,a)).rejects.toMatchObject({code:"CONTENT_BUSY"});
  await query("UPDATE deliveries SET lifecycle_status='unknown' WHERE message_id=$1",[first.message.id]);
  await expect(purgeContent("message",first.message.id,a)).rejects.toMatchObject({code:"CONTENT_BUSY"});
  await query("UPDATE deliveries SET lifecycle_status='canceled' WHERE message_id=$1",[first.message.id]);
  await purgeContent("message",first.message.id,a);
  expect((await acceptMessage({identity:newIdentity,input:mail,idempotencyKey:`rotation_${tag}`})).message).toEqual(first.message);
  await revokeServiceCredential(credential,"test");expect(await authenticateService(request(oldKey))).toBeNull();
  expect((await authenticateService(request(next.key)))?.serviceId).toBe(a);
  expect((await query("SELECT details FROM audit_logs WHERE action='service_credential.rotate' AND resource_id=$1",[next.id])).rows[0].details).toMatchObject({previousCredentialId:credential,oldCredentialRevoked:false});
 });
});
