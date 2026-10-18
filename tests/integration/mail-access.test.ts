import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {query,db} from '@/server/database';
import {hashApiKey} from '@/server/crypto';
import {sealSecret} from '@/modules/config/envelope';
import {authenticateService} from '@/server/auth';
import {createDomain,createInboundRoute,rotateServiceCredential,setDomainGrant,toggleDomainGrant} from '@/modules/admin/actions';
import {discoverMail} from '@/modules/core/resources/capabilities';
import {createMessageSchema,mailDiscoverySchema} from '@/lib/contracts';
import {persistInbound} from '@/modules/inbound/service';
import {getInboundMessage,listInboundMessages,getInboundAttachment,listDeliveries,listEvents,getMessageEvents,getMessageAttempts} from '@/modules/core/resources/service';
import {acceptMessage,cancelMessage,getMessage,listMessages,retryMessage} from '@/modules/core/message/service';
import {prepareSubmission} from '@/modules/core/routing/engine';
import {uploadOutboundFile,getOutboundFile,resolveOutboundAttachments} from '@/modules/files/service';
import {purgeContent} from '@/modules/core/resources/content';
import {listInboundChanges} from '@/modules/inbound/changes';
import {retryAttachmentScan} from '@/modules/attachments/tasks';
import {deliverCallback} from '@/modules/callbacks/service';
import {objectStore} from '@/modules/config/object-store';
import {GET as suppressionsGET} from '@/app/api/v1/suppressions/route';
const tag=crypto.randomUUID(),product=`prd_${tag}`,a=`svc_a_${tag}`,b=`svc_b_${tag}`,c=`svc_c_${tag}`;
const domain=`access-${tag}.test`,otherDomain=`other-${tag}.test`;
let domainId:string,otherId:string;
const key=(id:string)=>`fixture_key_${id}`;
const identity={serviceId:a,serviceName:'Business A',productId:product,product,rateLimitPerMinute:600};
const ownGrant=`grant_${a}`;
const request=(id=a)=>new Request('https://envoy.test/api/v1/capabilities',{headers:{authorization:`Bearer ${key(id)}`}});
const input=(from=`help@${domain}`)=>createMessageSchema.parse({from:{email:from},to:[{email:'customer@example.net'}],subject:'Private subject',text:'Private body'});
const receipt=()=>({externalMessageId:crypto.randomUUID(),from:'outside@example.net',to:[`help@${domain}`],cc:[],bcc:[`secret@${otherDomain}`],envelopeRecipients:[`help@${domain}`,`alias@${domain}`,`secret@${otherDomain}`],subject:'Inbound private',receivedAt:new Date(),text:'Body',attachments:[{fileName:'private.txt',contentType:'text/plain',content:Buffer.from('private')}]});
const persist=async()=>{
 const message=receipt();
 await persistInbound({providerAccountId:'pa_mock',webhookEndpointId:'pwe_mock',rawEventId:null as unknown as string,message});
 return (await query<{id:string}>('SELECT id FROM inbound_messages WHERE provider_account_id=$1 AND external_message_id=$2 AND service_id=$3',['pa_mock',message.externalMessageId,a])).rows[0].id;
};
beforeAll(async()=>{
 await query('INSERT INTO products(id,name) VALUES($1,$1)',[product]);
 domainId=(await createDomain({domain,accountIds:[]},'test')).domainId;otherId=(await createDomain({domain:otherDomain,accountIds:[]},'test')).domainId;
 for(const id of [a,b,c]){
  await query('INSERT INTO services(id,product_id,name) VALUES($1,$2,$1)',[id,product]);
  await query("INSERT INTO service_credentials(id,service_id,key_prefix,key_hash) VALUES($1,$2,'fixture',$3)",[`cred_${id}`,id,hashApiKey(key(id))]);
  const env=sealSecret({secret:'fixture_callback_secret'},`cb_${id}`,1);
  await query("INSERT INTO callback_endpoints(id,service_id,name,url,secret_ciphertext,encrypted_dek,key_version,subscribed_events) VALUES($1,$2,$2,'https://callback.test/events',$3,$4,$5,ARRAY['inbound.received','service.permissions_changed'])",[`cb_${id}`,id,env.secretCiphertext,env.encryptedDek,env.keyVersion]);
  const did=id===c?otherId:domainId;
  await query('INSERT INTO service_domain_grants(id,service_id,sending_domain_id,send_allowed,receive_allowed) VALUES($1,$2,$3,$4,true)',[`grant_${id}`,id,did,id===a]);
  await createInboundRoute({webhookEndpointId:'pwe_mock',domainId:did,productId:product,serviceId:id},'test');
 }
 await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status) VALUES($1,$2,'pa_mock','verified')",[`pi_${tag}`,domainId]);
 await query('INSERT INTO routing_policies(id,name,product_id,sending_domain_id) VALUES($1,$1,$2,$3)',[`rp_${tag}`,product,domainId]);
 await query("INSERT INTO routing_targets(id,policy_id,provider_account_id,provider_identity_id) VALUES($1,$2,'pa_mock',$3)",[`rt_${tag}`,`rp_${tag}`,`pi_${tag}`]);
});
afterAll(async()=>{
 const objects=(await query<{object_key:string}>(`SELECT a.object_key FROM inbound_attachments a JOIN inbound_messages i ON i.id=a.inbound_message_id WHERE i.product_id=$1 UNION ALL SELECT object_key FROM outbound_files WHERE service_id=ANY($2)`,[product,[a,b,c]])).rows;
 for(const o of objects)await objectStore().delete(o.object_key);
 await query('DELETE FROM callback_deliveries WHERE endpoint_id IN (SELECT id FROM callback_endpoints WHERE service_id=ANY($1))',[[a,b,c]]);
 await query('DELETE FROM messages WHERE product_id=$1',[product]);await query('DELETE FROM outbound_files WHERE service_id=ANY($1)',[[a,b,c]]);
 await query('DELETE FROM inbound_messages WHERE product_id=$1',[product]);await query('DELETE FROM routing_policies WHERE product_id=$1',[product]);
 await query('DELETE FROM products WHERE id=$1',[product]);await query('DELETE FROM sending_domains WHERE id=ANY($1)',[[domainId,otherId]]);await db().end();
});
describe('business domain permissions',()=>{
 it('discovers domain permissions and independent readiness without mailbox entities',async()=>{
  const d=mailDiscoverySchema.parse(await discoverMail(identity));expect(d.kind).toBe('domain_permissions');expect(d.domains).toHaveLength(1);
  expect(d.domains[0]).toMatchObject({id:domainId,domain,permissions:{send:true,receive:true},sending:{state:'configured'},receiving:{state:'configured'}});
  expect(JSON.stringify(d)).not.toMatch(/mailbox|applicationId|senders|receivers/);
  expect((await discoverMail({...identity,serviceId:b})).domains[0].permissions).toEqual({send:false,receive:true});
 });
 it('allows any local part in an authorized domain and denies other domains or receive-only keys',async()=>{
  await acceptMessage({identity,input:input(`arbitrary@${domain}`),idempotencyKey:crypto.randomUUID()});
  await expect(acceptMessage({identity,input:input(`help@${otherDomain}`),idempotencyKey:crypto.randomUUID()})).rejects.toMatchObject({code:'SENDER_NOT_AUTHORIZED'});
  await expect(acceptMessage({identity:{...identity,serviceId:b},input:input(),idempotencyKey:crypto.randomUUID()})).rejects.toMatchObject({code:'SENDER_NOT_AUTHORIZED'});
 });
 it('keeps provider submission facts as evidence without inventing recipient delivery',async()=>{
  const id=(await acceptMessage({identity,input:input(),idempotencyKey:crypto.randomUUID()})).message.id;
  const submission=(await query<{id:string}>('SELECT id FROM submissions WHERE message_id=$1',[id])).rows[0];
  const accepted='2026-01-01T00:00:00.000Z',delivered='2026-01-01T00:01:00.000Z';
  for(const [eventType,occurredAt] of [['accepted',accepted],['delivered',delivered]]) {
   const eid=crypto.randomUUID();
   await query('INSERT INTO submission_events(id,submission_id,event_type,source_key,occurred_at,canonical_payload) VALUES($1,$2,$3,$1,$4,$5)',[eid,submission.id,eventType,occurredAt,{type:eventType}]);
  }
  expect((await discoverMail(identity)).domains[0].evidence).toMatchObject({lastAcceptedAt:accepted,lastDeliveredAt:delivered});
  expect((await getMessage(id,a))?.deliveries[0].lifecycle_status).toBe('queued');
 });
 it('routes trusted envelope domains into private copies and one callback per service',async()=>{
  const first=await persist(),own=(await getInboundMessage(first,a))!;expect(own.envelopeRecipients.sort()).toEqual([`alias@${domain}`,`help@${domain}`].sort());expect(own.bcc).toEqual([]);
  expect(await getInboundMessage(first,b)).toBeNull();expect(await getInboundAttachment(first,own.attachments[0].id,b)).toBeNull();expect((await listInboundMessages(c,{limit:100})).data).toHaveLength(1);
  expect((await query('SELECT endpoint_id FROM callback_deliveries WHERE inbound_message_id=$1',[first])).rows).toEqual([{endpoint_id:`cb_${a}`}]);
 });
 it('rechecks revoked receive rights on all protected resource paths and filtered stream progress',async()=>{
  const id=await persist(),m=(await getInboundMessage(id,a))!,aid=m.attachments[0].id;await toggleDomainGrant(ownGrant,false,'test');
  try{expect(await getInboundMessage(id,a)).toBeNull();expect((await listInboundMessages(a,{limit:100})).data).toEqual([]);expect(await getInboundAttachment(id,aid,a)).toBeNull();expect(await retryAttachmentScan(aid,'inbound',a,'test')).toBeNull();expect(await purgeContent('inbound',id,a)).toBeNull();const feed=await listInboundChanges(a,100);expect(feed.data).toEqual([]);expect(feed.nextCursor).toBe(feed.watermark);}finally{await toggleDomainGrant(ownGrant,true,'test');}
 });
 it('rechecks revoked send rights for files, messages, events and queued submission',async()=>{
  const id=(await acceptMessage({identity,input:input(),idempotencyKey:crypto.randomUUID()})).message.id,file=await uploadOutboundFile(a,'private.txt','text/plain',Buffer.from('private'),domain),sid=(await query('SELECT id FROM submissions WHERE message_id=$1',[id])).rows[0].id;
  await toggleDomainGrant(ownGrant,false,'test');try{expect(await getMessage(id,a)).toBeNull();expect(await cancelMessage(id,a)).toBeNull();expect(await retryMessage(id,a,{acknowledgeDuplicateRisk:false},crypto.randomUUID())).toBeNull();expect((await listMessages(a,{limit:100})).data).toEqual([]);expect((await listDeliveries(a,{limit:100})).data).toEqual([]);expect((await listEvents(a,{limit:100})).data).toEqual([]);expect(await getMessageEvents(id,a,{limit:100})).toBeNull();expect(await getMessageAttempts(id,a,{limit:100})).toBeNull();expect(await getOutboundFile(file.id,a)).toBeNull();expect(await purgeContent('file',file.id,a)).toBeNull();expect(await prepareSubmission(sid)).toBeNull();}finally{await toggleDomainGrant(ownGrant,true,'test');}
 });
 it('denies cross-domain attachment reuse and duplicate business callback endpoints',async()=>{
  const file=await uploadOutboundFile(a,'private.txt','text/plain',Buffer.from('private'),domain);await expect(resolveOutboundAttachments(a,[{fileId:file.id,disposition:'attachment'}],undefined,otherId)).rejects.toMatchObject({reasonCode:'FILE_DOMAIN_MISMATCH'});
  await expect(query("INSERT INTO callback_endpoints(id,service_id,name,url,secret_ciphertext,encrypted_dek,key_version,subscribed_events) SELECT $1,service_id,name,url,secret_ciphertext,encrypted_dek,key_version,subscribed_events FROM callback_endpoints WHERE service_id=$2",[`duplicate_${tag}`,a])).rejects.toMatchObject({code:'23505'});
 });
 it('keeps the same business identity across rotation and commits minimal permission notifications',async()=>{
  const rotated=await rotateServiceCredential(`cred_${a}`,'test'),next=await authenticateService(new Request('https://envoy.test',{headers:{authorization:`Bearer ${rotated.key}`}}));expect(next?.serviceId).toBe(a);expect((await authenticateService(request()))?.serviceId).toBe(a);
  await setDomainGrant({serviceId:a,domainId,send:true,receive:true},'test');const e=(await query("SELECT id,payload FROM callback_deliveries WHERE endpoint_id=$1 AND event_type='service.permissions_changed' ORDER BY created_at DESC LIMIT 1",[`cb_${a}`])).rows[0];expect(e.payload).toMatchObject({type:'service.permissions_changed',data:{serviceId:a,productId:product}});expect((await query("SELECT id FROM outbox_events WHERE payload->>'callbackDeliveryId'=$1",[e.id])).rowCount).toBe(1);
 });
 it('keeps suppression management independently denied to ordinary business keys',async()=>{expect((await suppressionsGET(request())).status).toBe(403);});
 it('rechecks domain authorization before queued inbound callbacks leave Envoy',async()=>{
  const id=await persist(),e=(await query('SELECT id FROM callback_deliveries WHERE inbound_message_id=$1',[id])).rows[0];await toggleDomainGrant(ownGrant,false,'test');try{await deliverCallback(e.id);expect((await query('SELECT status FROM callback_deliveries WHERE id=$1',[e.id])).rows[0].status).toBe('dead_letter');}finally{await toggleDomainGrant(ownGrant,true,'test');}
 });
 it('rejects an inbound copy when receive rights are revoked while its bytes are being stored',async()=>{
  const store=objectStore(),put=store.put.bind(store),orphanKeys:string[]=[];
  let rejectedId:string|undefined;
  const spy=vi.spyOn(store,'put').mockImplementation(async(key,bytes,type)=>{
   await put(key,bytes,type);
   const id=key.split('/')[1],owner=(await query<{service_id:string}>('SELECT service_id FROM inbound_messages WHERE id=$1',[id])).rows[0];
   if(owner?.service_id===a){orphanKeys.push(key);rejectedId=id;await toggleDomainGrant(ownGrant,false,'test');}
  });
  try{
   await persist();expect(rejectedId).toBeTruthy();
   expect((await query('SELECT status,rejection_reason FROM inbound_messages WHERE id=$1',[rejectedId])).rows[0]).toEqual({status:'rejected',rejection_reason:'DOMAIN_RECEIVE_NOT_AUTHORIZED'});
   expect((await query('SELECT id FROM callback_deliveries WHERE inbound_message_id=$1',[rejectedId])).rows).toEqual([]);
  }finally{spy.mockRestore();await toggleDomainGrant(ownGrant,true,'test');for(const key of orphanKeys)await store.delete(key);}
 });
});
