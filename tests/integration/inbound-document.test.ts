import {randomUUID} from "node:crypto";
import {afterAll,describe,it,expect} from "vitest";
import {query,db,createUnitOfWork} from "@/platform/database";
import {persistInbound,getInboundMessage,reprojectInboundDocument,readInboundDocumentResource,listInboundChanges} from "@/modules/inbound/public";
import {createDocumentService} from '@/modules/inbound/application/document';
import {documentRepository} from '@/modules/inbound/infrastructure/document.repository';
import {sealSecret,openSecret} from '@/platform/crypto/envelope';
import {digest} from '@/modules/attachments/public';
afterAll(async()=>{await db().end();});
const bitmap=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWooAAAAASUVORK5CYII=','base64');
async function seed(html:string,text?:string){return persistInbound({providerAccountId:'pa_mock',webhookEndpointId:'pwe_mock',rawEventId:null!,message:{externalMessageId:`doc-${randomUUID()}`,from:'sender@example.test',to:['inbox@mail.atlas.test'],cc:[],bcc:[],subject:'Original message',html,text,textProvenance:text===undefined?'UNAVAILABLE':'AUTHORED',attachments:[],envelopeRecipients:['inbox@mail.atlas.test'],receivedAt:new Date()}});}
describe('versioned inbound documents on PostgreSQL',()=>{
 it('keeps HTML/text separate, prepares a protected encrypted bitmap, and fences ownership and erasure',async()=>{
  const id=await seed(`<table style="background:#eee"><tr><td><img src="data:image/png;base64,${bitmap.toString('base64')}">Original</td></tr></table>`,'Independent plain part');
  const message=(await getInboundMessage(id,'svc_atlas_auth'))!;
  expect(message).toMatchObject({text:'Independent plain part',document:{revision:'1',primaryRepresentation:'HTML',textProvenance:'AUTHORED',state:'CURRENT'}});
  expect(message.html).toContain('<table');expect(message.html).not.toContain('base64');
  const resource=message.document!.resources[0];expect(resource.downloadEligible).toBe(true);
  await expect(readInboundDocumentResource(id,resource.id,'other-service')).rejects.toMatchObject({status:404});
  const oldHost=process.env.CLAMAV_HOST;delete process.env.CLAMAV_HOST;
  try {
    const result=await readInboundDocumentResource(id,resource.id,'svc_atlas_auth');expect(Buffer.from(result.bytes)).toEqual(bitmap);expect(result.contentType).toBe('image/png');
    const stored=(await query<{source:unknown;cached_content:unknown}>("SELECT source,cached_content FROM inbound_document_resources WHERE id=$1",[resource.id])).rows[0];expect(JSON.stringify(stored)).not.toContain(bitmap.toString('base64'));expect(JSON.stringify(stored)).toContain('secretCiphertext');
    expect((await getInboundMessage(id,'svc_atlas_auth'))!.document!.resources[0]).toMatchObject({state:'READY',size:bitmap.length,contentType:'image/png'});
    await query("UPDATE inbound_messages SET content_purged_at=clock_timestamp() WHERE id=$1",[id]);
    const purged=(await getInboundMessage(id,'svc_atlas_auth'))!;expect(purged).toMatchObject({html:null,text:null,document:null});
    const erased=(await query("SELECT source,cached_content,state FROM inbound_document_resources WHERE id=$1",[resource.id])).rows[0];expect(erased).toEqual({source:null,cached_content:null,state:'ERASED'});
    await expect(readInboundDocumentResource(id,resource.id,'svc_atlas_auth')).rejects.toMatchObject({status:404});
    await expect(reprojectInboundDocument(id,'svc_atlas_auth','1')).rejects.toMatchObject({status:404});
  } finally {if(oldHost!==undefined)process.env.CLAMAV_HOST=oldHost;}
 });
 it('reprojects legacy retained MIME exactly once without redispatching or issuing change events',async()=>{
  const id=await seed('<p>placeholder</p>');
  const {objectStore}=await import('@/platform/storage/object-store');const key=`inbound/${id}/retained.eml`;
  await objectStore().put(key,Buffer.from('From: sender@example.test\r\nTo: inbox@mail.atlas.test\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<table class="brand"><tr><td style="padding:20px">Retained original</td></tr></table>'),'message/rfc822');
  await query("DELETE FROM inbound_document_resources WHERE inbound_message_id=$1",[id]);await query("UPDATE inbound_messages SET document_revision=0,document_projection=NULL,document_source=NULL,raw_mime_object_key=$2,text_body='legacy derived',sanitized_html='<p>legacy derived</p>' WHERE id=$1",[id,key]);
  const callbacks=(await query("SELECT count(*) FROM callback_deliveries WHERE inbound_message_id=$1",[id])).rows[0].count;
  const changes=await listInboundChanges('svc_atlas_auth',100);
  try {
    await reprojectInboundDocument(id,'svc_atlas_auth','0');const restored=(await getInboundMessage(id,'svc_atlas_auth'))!;
    expect(restored.document).toMatchObject({revision:'1',state:'CURRENT',primaryRepresentation:'HTML',textProvenance:'UNAVAILABLE'});expect(restored.html).toContain('class="brand"');expect(restored.html).toContain('padding:20px');expect(restored.text).toBeNull();
    await reprojectInboundDocument(id,'svc_atlas_auth','1');await expect(reprojectInboundDocument(id,'svc_atlas_auth','0')).rejects.toMatchObject({status:409});
    expect((await query("SELECT count(*) FROM callback_deliveries WHERE inbound_message_id=$1",[id])).rows[0].count).toBe(callbacks);
    expect((await listInboundChanges('svc_atlas_auth',100,changes.nextCursor)).data).toEqual([]);
  } finally {await objectStore().delete(key);}
 });
 it('marks source unavailable honestly and refuses private remote network targets',async()=>{
  const id=await seed('<img src="http://127.0.0.1/private">');const resource=(await getInboundMessage(id,'svc_atlas_auth'))!.document!.resources[0];
  await expect(readInboundDocumentResource(id,resource.id,'svc_atlas_auth')).rejects.toMatchObject({status:409});
  expect((await getInboundMessage(id,'svc_atlas_auth'))!.document!.resources[0]).toMatchObject({state:'UNAVAILABLE',reasonCode:'NETWORK_BLOCKED',downloadEligible:false});
  const legacy=await seed('<p>legacy</p>','Only retained text');await query("UPDATE inbound_messages SET document_revision=0,document_projection=NULL,document_source=NULL,raw_mime_object_key=NULL WHERE id=$1",[legacy]);
  await reprojectInboundDocument(legacy,'svc_atlas_auth','0');expect((await getInboundMessage(legacy,'svc_atlas_auth'))!).toMatchObject({html:null,text:'Only retained text',document:{state:'SOURCE_UNAVAILABLE',textProvenance:'NOT_RECORDED',primaryRepresentation:'TEXT'}});
 });
 it('publishes NUL replacement as a partial PostgreSQL-safe body while retaining encrypted original',async()=>{
  const id=await seed('<p>A\u0000B</p>','A\u0000B');const message=(await getInboundMessage(id,'svc_atlas_auth'))!;expect(message).toMatchObject({html:'<p>A�B</p>',text:'A�B',document:{state:'PARTIAL'}});const stored=(await query("SELECT document_source FROM inbound_messages WHERE id=$1",[id])).rows[0].document_source;expect(JSON.stringify(stored)).not.toContain('A�B');
 });
 it('uses original persisted provider identity without a webhook receipt and rejects post-read revocation',async()=>{
  const tag=randomUUID(),account=`pa_${tag}`,id=`inb_${tag}`;
  await query("INSERT INTO provider_accounts(id,type,name,public_config) VALUES($1,'resend','Retained-source fixture','{}')",[account]);
  await query("INSERT INTO domain_inbound_sources(sending_domain_id,provider_account_id) VALUES('sd_atlas',$1)",[account]);
  await query("INSERT INTO inbound_messages(id,service_id,provider_account_id,external_message_id,delivery_scope,from_email,to_emails,envelope_recipients,subject,status,text_body) VALUES($1,'svc_atlas_auth',$2,'original-native-fixture','svc_atlas_auth','author@example.test','{}',ARRAY['inbox@mail.atlas.test'],'Original','ready','legacy text')",[id,account]);
  try {
  let revoke=true;
  const documents=createDocumentService({repository:documentRepository(),unitOfWork:createUnitOfWork(documentRepository),id:()=>`idr_${randomUUID()}`,digest,seal:(value,key)=>sealSecret(value,key,1),open:(value,key)=>openSecret(value,key,1),rawSource:async()=>{throw new Error('No raw source allowed');},
    retainedSource:async(record,authorize)=>{expect(record.receipt).toBeNull();expect(record.providerIdentity).toEqual({providerType:'resend',accountId:account,externalId:'original-native-fixture'});await authorize();if(revoke)await query("UPDATE service_domain_bindings SET receive_enabled=false WHERE id='sdb_atlas'");return {html:'<table><tr><td>Retained genuine-source fixture</td></tr></table>',text:null,textProvenance:'UNAVAILABLE'};},
    fetchImage:async()=>{throw new Error('No network in fixture');},readAttachment:async()=>null,scan:async()=>({status:'PENDING',sha256:''}),scanPolicy:()=> 'fixture',});
  try {await expect(documents.reproject(id,'svc_atlas_auth','0')).rejects.toMatchObject({status:409});expect((await query("SELECT document_revision::text,document_projection FROM inbound_messages WHERE id=$1",[id])).rows[0]).toEqual({document_revision:'0',document_projection:null});}
  finally {await query("UPDATE service_domain_bindings SET receive_enabled=true WHERE id='sdb_atlas'");}
  revoke=false;await documents.reproject(id,'svc_atlas_auth','0');expect((await getInboundMessage(id,'svc_atlas_auth'))!).toMatchObject({html:'<table><tr><td>Retained genuine-source fixture</td></tr></table>',text:null,document:{revision:'1',state:'CURRENT',primaryRepresentation:'HTML'}});
  } finally {
    await query("UPDATE service_domain_bindings SET receive_enabled=true WHERE id='sdb_atlas'");
    await query("DELETE FROM inbound_messages WHERE id=$1",[id]);
    await query("DELETE FROM domain_inbound_sources WHERE provider_account_id=$1",[account]);
    await query("DELETE FROM provider_accounts WHERE id=$1",[account]);
  }
 });
 it('rechecks the full frozen envelope grant on protected reads',async()=>{
  const id=await seed('<p>Retained</p>');await query("UPDATE service_domain_bindings SET receive_enabled=false WHERE id='sdb_atlas'");
  try{expect(await getInboundMessage(id,'svc_atlas_auth')).toBeNull();await expect(reprojectInboundDocument(id,'svc_atlas_auth','1')).rejects.toMatchObject({status:404});}
  finally{await query("UPDATE service_domain_bindings SET receive_enabled=true WHERE id='sdb_atlas'");}
 });
});
