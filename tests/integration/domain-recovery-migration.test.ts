import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, Pool, type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { initializeApplicationSchema, initializeDatabase } from "@/platform/database/initialization";
import { loadApplicationMigrations } from "../../db/migrations";

vi.setConfig({testTimeout:30_000});
async function isolated(work:(client:PoolClient)=>Promise<void>) {
  const adminUrl=process.env.TEST_DATABASE_ADMIN_URL!;
  const name=`envoy_domain_upgrade_${randomUUID().replaceAll("-","")}`;
  const admin=new Client({connectionString:adminUrl});await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const url=new URL(adminUrl);url.pathname=`/${name}`;
  const pool=new Pool({connectionString:url.toString()});
  const client=await pool.connect();
  try {await work(client);}
  finally {client.release();await pool.end();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();}
}
async function seed(client:PoolClient) {
  await client.query(`INSERT INTO provider_accounts(id,type,name,public_config) VALUES('pa_upgrade','resend','Provider before recovery','{}');
    INSERT INTO sending_domains(id,domain,status) VALUES('domain_ready','ready.example.test','active'),('domain_disabled','disabled.example.test','disabled');
    INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,external_identity_id,status,dns_records,last_checked_at)
      VALUES('identity_ready','domain_ready','pa_upgrade','remote-ready','verified','[{"type":"TXT","name":"dkim","value":"original"}]','2026-01-01'),
      ('identity_disabled','domain_disabled','pa_upgrade','remote-disabled','disabled','[]',NULL);
    INSERT INTO services(id,name) VALUES('service_upgrade','Before recovery');
    INSERT INTO service_domain_bindings(id,service_id,sending_domain_id,receive_enabled,outbound_provider_identity_id)
      VALUES('binding_upgrade','service_upgrade','domain_ready',true,'identity_ready');`);
}
async function previousFacts(client:PoolClient, upgraded=false) {
  const identityColumns=upgraded ? "-'archived_at'-'sync_after'-'sync_lease_until'-'sync_lease_token'-'sync_failures'-'sync_attempt_at'-'sync_error'" : "";
  const domainColumns=upgraded ? "-'archived_at'" : "";
  return (await client.query(`SELECT jsonb_build_object(
    'domains',(SELECT jsonb_agg(to_jsonb(d)${domainColumns} ORDER BY id) FROM sending_domains d),
    'identities',(SELECT jsonb_agg(to_jsonb(i)${identityColumns} ORDER BY id) FROM provider_identities i),
    'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM service_domain_bindings b)) AS facts`)).rows[0].facts;
}

describe("domain recovery V7 migration",()=>{
  it("preserves populated V6 identity verification, disable state, DNS and Service grants",async()=>{
    await isolated(async client=>{
      const migrations=await loadApplicationMigrations(), baseline=migrations.slice(0,6);
      await initializeApplicationSchema(client,baseline,baseline.map(row=>row.sql).join("\n"));
      await seed(client);const before=await previousFacts(client);
      expect(await initializeDatabase(client)).toBe("upgraded");
      expect(await previousFacts(client,true)).toEqual(before);
      const states=(await client.query("SELECT archived_at,sync_lease_until,sync_lease_token,sync_failures,sync_attempt_at,sync_error,sync_after IS NOT NULL AS scheduled FROM provider_identities ORDER BY id")).rows;
      expect(states).toEqual(Array.from({length:2},()=>({archived_at:null,sync_lease_until:null,sync_lease_token:null,sync_failures:0,sync_attempt_at:null,sync_error:null,scheduled:true})));
      expect(await initializeDatabase(client)).toBe("validated");
      expect(await previousFacts(client,true)).toEqual(before);
    });
  });
  it("rolls back all V7 additions after late failure and permits clean retry",async()=>{
    await isolated(async client=>{
      const migrations=await loadApplicationMigrations(), baseline=migrations.slice(0,6);
      await initializeApplicationSchema(client,baseline,baseline.map(row=>row.sql).join("\n"));
      await seed(client);const before=await previousFacts(client);
      const failing=[...baseline,{...migrations[6],sql:`${migrations[6].sql}\nSELECT missing_domain_recovery_function();`}];
      await expect(initializeApplicationSchema(client,failing,await readFile("db/schema.sql","utf8"))).rejects.toThrow("missing_domain_recovery_function");
      expect(await previousFacts(client)).toEqual(before);
      expect((await client.query("SELECT count(*)::int AS count FROM envoy_meta.migrations")).rows[0].count).toBe(6);
      expect((await client.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('sending_domains','provider_identities') AND (column_name='archived_at' OR column_name LIKE 'sync_%')")).rows[0].count).toBe(0);
      expect(await initializeDatabase(client)).toBe("upgraded");
      expect(await initializeDatabase(client)).toBe("validated");
      expect(await previousFacts(client,true)).toEqual(before);
    });
  });
});
