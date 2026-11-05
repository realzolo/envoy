import {EventEmitter} from 'node:events';
import {beforeEach,describe,it,expect,vi} from 'vitest';
import type {DocumentRecord} from '@/modules/inbound/application/document';
const fixtures=vi.hoisted(()=>({request:vi.fn(),load:vi.fn(),target:vi.fn(),stored:vi.fn(),status:200,body:{id:'original-native-id',html:'<table><tr><td>Original HTML</td></tr></table>',text:'Independent text'},writes:0}));
vi.mock('node:https',()=>({request:fixtures.request}));
vi.mock('@/platform/storage/object-store',()=>({objectStore:()=>({get:fixtures.stored})}));
vi.mock('@/modules/channels/public',()=>({loadProviderAccount:fixtures.load}));
vi.mock('@/modules/inbound/infrastructure/document-media',()=>({mediaTarget:fixtures.target}));
import {readRetainedDocumentSource} from '@/modules/inbound/infrastructure/document-source';
const record:DocumentRecord={id:'inb_owned',revision:'0',source:null,rawKey:null,text:'legacy',document:null,purged:false,receipt:null,providerIdentity:{providerType:'resend',accountId:'pa_original',externalId:'original-native-id'}};
beforeEach(()=>{
 vi.clearAllMocks();fixtures.stored.mockRejectedValue(Object.assign(new Error("expired"),{code:"ENOENT"}));fixtures.writes=0;fixtures.status=200;fixtures.body={id:'original-native-id',html:'<table><tr><td>Original HTML</td></tr></table>',text:'Independent text'};
 fixtures.load.mockResolvedValue({context:{secret:{type:'resend',apiKey:'fixture-secret'}}});
 fixtures.target.mockImplementation(async(url:string)=>({url:new URL(url),addresses:[{address:'8.8.8.8',family:4}]}));
 fixtures.request.mockImplementation((_url:URL,_options:unknown,callback:(res:EventEmitter&{statusCode:number;headers:object;destroy:()=>void})=>void)=>{
   const request=new EventEmitter() as EventEmitter&{end:()=>void;destroy:(error?:Error)=>void};
   request.end=()=>{fixtures.writes++;const response=Object.assign(new EventEmitter(),{statusCode:fixtures.status,headers:{},destroy:()=>{}});callback(response);queueMicrotask(()=>{response.emit('data',Buffer.from(JSON.stringify(fixtures.body)));response.emit('end');});};
   request.destroy=(error?:Error)=>{if(error)request.emit('error',error);};
   queueMicrotask(()=>{const socket=new EventEmitter();request.emit('socket',socket);queueMicrotask(()=>socket.emit('secureConnect'));});return request;
 });
});
describe('original provider source without retained webhook receipt',()=>{
 it('uses only the original stored native identity and rechecks ownership/current credential at the final write',async()=>{
   const authorize=vi.fn(async()=>{});const result=await readRetainedDocumentSource(record,authorize);
   expect(result).toMatchObject({html:fixtures.body.html,text:'Independent text',textProvenance:'NOT_RECORDED'});
   expect(fixtures.target).toHaveBeenCalledWith('https://api.resend.com/emails/receiving/original-native-id?html_format=cid');
   expect(fixtures.load).toHaveBeenNthCalledWith(1,'pa_original');expect(fixtures.load).toHaveBeenNthCalledWith(2,'pa_original');expect(authorize).toHaveBeenCalledTimes(2);expect(fixtures.writes).toBe(1);
 });
 it('falls back to original fixed provider identity when the retained receipt object expired',async()=>{
   const result=await readRetainedDocumentSource({...record,receipt:{id:'old-receipt',providerType:'resend',accountId:'pa_original',externalId:'original-native-id',envelope:['private@example.test'],verification:{objectKey:'expired-private-receipt'}}},async()=>{});
   expect(result).toMatchObject({html:fixtures.body.html,textProvenance:'NOT_RECORDED'});expect(fixtures.writes).toBe(1);
 });
 it('does not write a provider request after ownership is revoked during TLS',async()=>{
   await expect(readRetainedDocumentSource(record,async()=>{throw new Error('revoked');})).rejects.toThrow('revoked');expect(fixtures.writes).toBe(0);
 });
 it('does not use a stale provider credential or a changed remote identity',async()=>{
   fixtures.load.mockResolvedValueOnce({context:{secret:{type:'resend',apiKey:'old'}}}).mockResolvedValue({context:{secret:{type:'resend',apiKey:'new'}}});
   await expect(readRetainedDocumentSource(record,async()=>{})).rejects.toMatchObject({code:'DOCUMENT_PREPARING'});expect(fixtures.writes).toBe(0);
   fixtures.load.mockResolvedValue({context:{secret:{type:'resend',apiKey:'fixture-secret'}}});fixtures.body.id='different-message';
   await expect(readRetainedDocumentSource(record,async()=>{})).rejects.toMatchObject({code:'DOCUMENT_PREPARING'});
 });
 it('treats actual provider source expiry as unavailable, without guessing from legacy text',async()=>{
   fixtures.status=404;expect(await readRetainedDocumentSource(record,async()=>{})).toBeNull();
 });
});
