import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,describe,expect,it} from 'vitest';
import {query} from '@/platform/database';
import {identitySyncRepository} from '@/modules/channels/infrastructure/identity-sync.repository';

let domain:string,account:string,identity:string;
beforeEach(async()=>{
  const tag=randomUUID();domain=`sd_${tag}`;account=`pa_${tag}`;identity=`pi_${tag}`;
  await query("INSERT INTO provider_accounts(id,type,name,status,public_config) VALUES($1,'resend','Scheduled Resend','active','{}')",[account]);
  await query(`INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by)
    SELECT $1,$2,1,secret_ciphertext,encrypted_dek,key_version,'test' FROM provider_credentials WHERE provider_account_id='pa_mock' AND status='active'`,[`pc_${tag}`,account]);
  await query("INSERT INTO sending_domains(id,domain) VALUES($1,$2)",[domain,`${tag}.example.com`]);
  await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status) VALUES($1,$2,$3,'pending')",[identity,domain,account]);
});
afterEach(async()=>{
  await query("DELETE FROM sending_domains WHERE id=$1",[domain]);
  await query("DELETE FROM provider_accounts WHERE id=$1",[account]);
});

describe('durable provider identity synchronization leases',()=>{
  it('claims once across schedulers and fences a late completion after reclamation',async()=>{
    const before=(await query("SELECT updated_at FROM provider_identities WHERE id=$1",[identity])).rows[0];
    const [left,right]=await Promise.all([identitySyncRepository.claim('left'),identitySyncRepository.claim('right')]);
    const first=left ?? right;expect(first?.id).toBe(identity);expect([left,right].filter(Boolean)).toHaveLength(1);
    await query("UPDATE provider_identities SET sync_lease_until=now()-interval '1 second' WHERE id=$1",[identity]);
    expect(await identitySyncRepository.claim('new')).toMatchObject({id:identity,token:'new'});
    await identitySyncRepository.finish({id:identity,token:first!.token,delaySeconds:3600,failed:true,error:'stale'});
    expect((await query("SELECT sync_lease_token,sync_failures,sync_error FROM provider_identities WHERE id=$1",[identity])).rows[0]).toEqual({sync_lease_token:'new',sync_failures:0,sync_error:null});
    await identitySyncRepository.finish({id:identity,token:'new',delaySeconds:60,failed:false,error:null});
    expect(await identitySyncRepository.claim('again')).toBeNull();
    expect((await query("SELECT updated_at FROM provider_identities WHERE id=$1",[identity])).rows[0]).toEqual(before);
  });
  it('persists failure backoff and preserves diagnostics during account pacing',async()=>{
    await identitySyncRepository.claim('failed');
    await identitySyncRepository.finish({id:identity,token:'failed',delaySeconds:300,failed:true,error:'Temporary provider failure'});
    expect((await query("SELECT sync_failures,sync_error,sync_after>now()+interval '4 minutes' AS backed_off FROM provider_identities WHERE id=$1",[identity])).rows[0]).toEqual({sync_failures:1,sync_error:'Temporary provider failure',backed_off:true});
    await query("UPDATE provider_identities SET sync_after=now() WHERE id=$1",[identity]);
    await identitySyncRepository.claim('paced');
    await identitySyncRepository.finish({id:identity,token:'paced',delaySeconds:10,failed:false,deferred:true,error:null});
    expect((await query("SELECT sync_failures,sync_error FROM provider_identities WHERE id=$1",[identity])).rows[0]).toEqual({sync_failures:1,sync_error:'Temporary provider failure'});
  });
  it('excludes disabled, archived and unavailable resources',async()=>{
    await query("UPDATE provider_identities SET status='disabled' WHERE id=$1",[identity]);
    expect(await identitySyncRepository.claim('disabled')).toBeNull();
    await query("UPDATE provider_identities SET status='pending',archived_at=now() WHERE id=$1",[identity]);
    expect(await identitySyncRepository.claim('archived-identity')).toBeNull();
    await query("UPDATE provider_identities SET archived_at=NULL WHERE id=$1",[identity]);
    await query("UPDATE sending_domains SET archived_at=now() WHERE id=$1",[domain]);
    expect(await identitySyncRepository.claim('archived-domain')).toBeNull();
    await query("UPDATE sending_domains SET archived_at=NULL,status='disabled' WHERE id=$1",[domain]);
    expect(await identitySyncRepository.claim('disabled-domain')).toBeNull();
    await query("UPDATE sending_domains SET status='active' WHERE id=$1",[domain]);
    await query("UPDATE provider_accounts SET status='disabled' WHERE id=$1",[account]);
    expect(await identitySyncRepository.claim('disabled-account')).toBeNull();
  });
});
