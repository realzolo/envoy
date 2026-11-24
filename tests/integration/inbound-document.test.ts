import {randomUUID} from "node:crypto";
import {afterAll,describe,it,expect} from "vitest";
import {query,db} from "@/platform/database";
import {persistInbound,getInboundMessage} from "@/modules/inbound/public";
import {readInboundReaderSource} from "@/modules/inbound/sources";
import {mailReader} from "@/modules/mail-reader/public";
afterAll(async()=>{await db().end();});
const bitmap=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWooAAAAASUVORK5CYII=','base64');
async function seed(html:string,text?:string){return persistInbound({providerAccountId:'pa_mock',webhookEndpointId:'pwe_mock',rawEventId:null!,message:{externalMessageId:`doc-${randomUUID()}`,from:'sender@example.test',to:['inbox@mail.atlas.test'],cc:[],bcc:[],subject:'Original message',html,text,textProvenance:text===undefined?'UNAVAILABLE':'AUTHORED',attachments:[],envelopeRecipients:['inbox@mail.atlas.test'],receivedAt:new Date()}});}
describe('original document facts and unified hosted reader',()=>{
 it('preserves original HTML/text and atomically queues resources as part of a ready copy',async()=>{
  const id=await seed(`<table style="background:#eee"><tr><td><img src="data:image/png;base64,${bitmap.toString('base64')}">Original</td></tr></table>`,'Independent plain part');
  const facts=(await getInboundMessage(id,'svc_atlas_auth'))!;expect(facts).toMatchObject({text:'Independent plain part',document:{primaryRepresentation:'HTML',textProvenance:'AUTHORED'}});
  const source=await readInboundReaderSource(id,'svc_atlas_auth');expect(source?.html).toContain('base64');expect(source?.text).toBe('Independent plain part');
  const queued=(await query<{source_revision:string;state:string}>("SELECT source_revision,state FROM mail_reader_resources WHERE source_kind='INBOUND' AND source_id=$1",[id])).rows;expect(queued).toHaveLength(1);expect(queued[0].state).toBe('PENDING');
  const session=await mailReader.issue({kind:'INBOUND',id,serviceId:'svc_atlas_auth'},'https://envoy.test');expect(session.documentRevision).toBe(queued[0].source_revision);
  const token=session.url.split('/').at(-1)!;const image=await mailReader.readResource(token,'resource_1');expect(Buffer.from(image.bytes)).toEqual(bitmap);expect(image.contentType).toBe('image/png');
  const status=await mailReader.status(token);expect(status).toMatchObject({total:1,ready:1,active:0,failed:0,nextCheckAt:null});
 });
 it('denies another Service, revocation and parent erasure without using previously prepared bytes',async()=>{
  const id=await seed(`<img src="data:image/png;base64,${bitmap.toString('base64')}">`);
  expect(await readInboundReaderSource(id,'wrong-service')).toBeNull();
  const session=await mailReader.issue({kind:'INBOUND',id,serviceId:'svc_atlas_auth'},'https://envoy.test'),token=session.url.split('/').at(-1)!;await mailReader.readResource(token,'resource_1');
  await query("UPDATE service_domain_bindings SET receive_enabled=false WHERE service_id='svc_atlas_auth'");
  try{await expect(mailReader.status(token)).rejects.toMatchObject({status:404});}finally{await query("UPDATE service_domain_bindings SET receive_enabled=true WHERE service_id='svc_atlas_auth'");}
  await query("UPDATE inbound_messages SET content_purged_at=clock_timestamp() WHERE id=$1",[id]);await expect(mailReader.readResource(token,'resource_1')).rejects.toMatchObject({status:404});
  expect((await query("SELECT 1 FROM mail_reader_resources WHERE source_kind='INBOUND' AND source_id=$1",[id])).rows).toHaveLength(0);
 });
});
