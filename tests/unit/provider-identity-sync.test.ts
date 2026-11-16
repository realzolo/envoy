import {describe,expect,it,vi} from 'vitest';
import {createIdentitySyncService,identitySyncDelay,identitySyncFailure,type IdentitySyncClaim,type IdentitySyncRepository} from '@/modules/channels/application/identity-sync';

function fixture(claims: IdentitySyncClaim[]) {
  const repository={claim:vi.fn(async()=>claims.shift() ?? null),finish:vi.fn<IdentitySyncRepository["finish"]>(async()=>undefined)};
  const refresh=vi.fn(async()=>({status:'pending'}));
  const allowAccount=vi.fn(async()=>true);
  return {repository,refresh,allowAccount,run:createIdentitySyncService({repository,refresh,allowAccount,token:()=> 'token'})};
}
const task=(id:string,failures=0)=>({id,accountId:'account',failures,token:`lease-${id}`});

describe('background provider identity sync',()=>{
  it('bounds work and checks verified domains much less often than pending domains',async()=>{
    const f=fixture([task('pending'),task('verified'),task('leftover')]);
    f.refresh.mockResolvedValueOnce({status:'pending'}).mockResolvedValueOnce({status:'verified'});
    await expect(f.run(2)).resolves.toEqual({synced:2});
    expect(f.repository.claim).toHaveBeenCalledTimes(2);
    expect(f.refresh).toHaveBeenCalledWith('pending','lease-pending');
    expect(f.repository.finish.mock.calls.map(([input])=>input)).toEqual([
      {id:'pending',token:'lease-pending',delaySeconds:60,failed:false,deferred:false,error:null},
      {id:'verified',token:'lease-verified',delaySeconds:21600,failed:false,deferred:false,error:null},
    ]);
  });
  it('backs off a failed identity and continues processing the next due identity',async()=>{
    const f=fixture([task('failure',3),task('next')]);
    f.refresh.mockRejectedValueOnce({statusCode:429,message:'private-api-key'});
    await expect(f.run()).resolves.toEqual({synced:1});
    expect(f.repository.finish).toHaveBeenNthCalledWith(1,expect.objectContaining({id:'failure',delaySeconds:480,failed:true,error:'Provider rate limit reached. Sync will retry automatically.'}));
    expect(JSON.stringify(f.repository.finish.mock.calls)).not.toContain('private-api-key');
    expect(f.refresh).toHaveBeenCalledTimes(2);
  });
  it('defers a rate-limited account without falsely reporting successful provider sync',async()=>{
    const f=fixture([task('paced',4)]);f.allowAccount.mockResolvedValue(false);
    await expect(f.run()).resolves.toEqual({synced:0});
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.repository.finish).toHaveBeenCalledWith(expect.objectContaining({delaySeconds:10,failed:false,deferred:true}));
  });
  it('caps exponential backoff and sanitizes arbitrary upstream messages',()=>{
    expect(identitySyncDelay(1000,new Error('secret'))).toBe(3600);
    expect(identitySyncDelay(0,{statusCode:429})).toBe(300);
    expect(identitySyncDelay(0,{statusCode:429,retryAfterSeconds:7200})).toBe(7200);
    expect(identitySyncDelay(0,{statusCode:429,retryAfterSeconds:NaN})).toBe(300);
    expect(identitySyncFailure({statusCode:403,message:'private'})).toContain('permissions');
    expect(identitySyncFailure(new Error('private'))).not.toContain('private');
  });
});
