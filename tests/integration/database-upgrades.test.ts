import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { initializeApplicationSchema, initializeDatabase } from "@/platform/database/initialization";
import { loadApplicationMigrations } from "../../db/migrations";

async function isolated(work: (pool: Pool) => Promise<void>) {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL!, name = `envoy_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  const disconnected:Promise<void>[]=[];
  pool.on("connect",client=>disconnected.push(new Promise(resolve=>client.once("end",resolve))));
  try { await work(pool); }
  finally { await pool.end(); await Promise.all(disconnected); await admin.query(`DROP DATABASE "${name}"`); await admin.end(); }
}
async function seed(client: PoolClient) {
  await client.query(`INSERT INTO services(id,name) VALUES('svc_upgrade','upgrade');
    INSERT INTO service_credentials(id,service_id,key_prefix,key_hash) VALUES('cred_upgrade','svc_upgrade','prefix','preserved-hash');
    INSERT INTO sending_domains(id,domain) VALUES('domain_upgrade','upgrade.example.test');
    INSERT INTO service_domain_bindings(id,service_id,sending_domain_id) VALUES('binding_upgrade','svc_upgrade','domain_upgrade');
    INSERT INTO messages(id,service_id,sending_domain_id,sender_snapshot,idempotency_key,payload_hash,recipient_count,subject,text_body,message_category)
      VALUES('msg_upgrade','svc_upgrade','domain_upgrade','{}','retained-key','retained-hash',1,'retained subject','retained body','security');
    INSERT INTO deliveries(id,message_id,recipient_email,recipient_role) VALUES('delivery_upgrade','msg_upgrade','recipient@example.test','to');
    INSERT INTO submissions(id,message_id) VALUES('submission_upgrade','msg_upgrade');
    INSERT INTO delivery_events(id,delivery_id,event_type,source_key,occurred_at,canonical_payload) VALUES('event_upgrade','delivery_upgrade','delivered','event-source','1900-01-01','{}');
    INSERT INTO submission_events(id,submission_id,event_type,source_key,occurred_at,canonical_payload) VALUES('submission_event_upgrade','submission_upgrade','accepted','submission-source','1900-01-01','{}');`);
}
async function preserved(client: PoolClient) {
  return (await client.query(`SELECT jsonb_build_object('service',(SELECT to_jsonb(s) FROM services s WHERE id='svc_upgrade'),
    'key',(SELECT to_jsonb(k) FROM service_credentials k WHERE id='cred_upgrade'),
    'message',(SELECT to_jsonb(m) FROM messages m WHERE id='msg_upgrade'),
    'delivery',(SELECT to_jsonb(d)-'last_error'-'diagnostic'-'revision'-'retry_disposition' FROM deliveries d WHERE id='delivery_upgrade'),
    'event',(SELECT to_jsonb(e)-'canonical_payload' FROM delivery_events e WHERE id='event_upgrade'),
    'submissionEvent',(SELECT to_jsonb(e)-'canonical_payload' FROM submission_events e WHERE id='submission_event_upgrade')) AS facts`)).rows[0].facts;
}

describe("application database migrations", () => {
  it("converts V4 diagnostics without inventing historical detail and removes retired text",async()=>{
    await isolated(async pool=>{
      const client=await pool.connect();
      try {
        const migrations=await loadApplicationMigrations();
        await initializeApplicationSchema(client,migrations.slice(0,4),migrations.slice(0,4).map(item=>item.sql).join("\n"));
        await seed(client);
        await client.query("UPDATE deliveries SET lifecycle_status='bounced',last_error=$1 WHERE id='delivery_upgrade'",[{code:"MAILBOX_PERMANENTLY_REJECTED",stage:"recipient_delivery",message:"private verification 624918",providerCode:"raw private 624918"}]);
        await client.query("INSERT INTO request_logs(request_id,method,path,status_code,duration_ms,service_id,details) VALUES('request_legacy','POST','/api/v1/messages',422,1,'svc_upgrade',$1)",[{problem:{code:"VALIDATION_FAILED",errors:{"to.0.email":["Invalid email address"]}}}]);
        await client.query(`INSERT INTO deliveries(id,message_id,recipient_email,recipient_role,lifecycle_status,last_error) VALUES
          ('accepted_legacy','msg_upgrade','accepted@example.test','to','accepted',NULL),
          ('workflow_legacy','msg_upgrade','workflow@example.test','to','deferred','{"code":"WORKFLOW_EXHAUSTED","stage":"queue"}');
          INSERT INTO provider_accounts(id,type,name,public_config) VALUES('pa_legacy','mock','Legacy','{}');
          INSERT INTO provider_identities(id,sending_domain_id,provider_account_id) VALUES('pi_legacy','domain_upgrade','pa_legacy');
          INSERT INTO submission_attempts(id,submission_id,attempt_number,provider_account_id,provider_identity_id,routing_snapshot,request_fingerprint,status,reconcile_after)
          VALUES('attempt_legacy','submission_upgrade',1,'pa_legacy','pi_legacy','{}','legacy','unknown',now()+interval '5 minutes');
          INSERT INTO deliveries(id,message_id,recipient_email,recipient_role,lifecycle_status,current_submission_id,current_attempt_id)
          VALUES('reconcile_legacy','msg_upgrade','reconcile@example.test','to','unknown','submission_upgrade','attempt_legacy');`);
        expect(await initializeDatabase(client)).toBe("upgraded");
        const row=(await client.query("SELECT diagnostic,revision::text,retry_disposition FROM deliveries WHERE id='delivery_upgrade'")).rows[0];
        expect(row).toMatchObject({revision:"1",diagnostic:{code:"MAILBOX_PERMANENTLY_REJECTED",reasonCode:null,detailAvailability:"NOT_RECORDED",occurredAt:null},retry_disposition:{owner:"NONE",action:"STOPPED"}});
        expect(JSON.stringify(row)).not.toContain("624918");
        expect((await client.query("SELECT details#>'{problem,diagnostic}' AS diagnostic FROM request_logs WHERE request_id='request_legacy'")).rows[0].diagnostic).toMatchObject({source:"ENVOY",code:"VALIDATION_FAILED",reasonCode:null,detailAvailability:"NOT_RECORDED",occurredAt:null});
        const retries=(await client.query("SELECT id,retry_disposition FROM deliveries WHERE id IN ('accepted_legacy','workflow_legacy','reconcile_legacy') ORDER BY id")).rows;
        expect(retries).toMatchObject([{id:"accepted_legacy",retry_disposition:{owner:"PROVIDER",action:"WAITING_PROVIDER",nextAttemptAt:null}},{id:"reconcile_legacy",retry_disposition:{owner:"ENVOY",action:"SCHEDULED",nextAttemptAt:expect.any(String)}},{id:"workflow_legacy",retry_disposition:{owner:"ENVOY",action:"MANUAL_REVIEW",nextAttemptAt:null}}]);
        expect((await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='submission_attempts' AND column_name IN ('error_code','error_category','error_message')")).rowCount).toBe(0);
        expect(await initializeDatabase(client)).toBe("validated");
      } finally {client.release();}
    });
  });
  it("rolls back V5 conversion atomically when a later statement fails",async()=>{
    await isolated(async pool=>{
      const client=await pool.connect();
      try {
        const migrations=await loadApplicationMigrations();
        await initializeApplicationSchema(client,migrations.slice(0,4),migrations.slice(0,4).map(item=>item.sql).join("\n"));await seed(client);
        const before=await preserved(client);
        const failing=[...migrations.slice(0,4),{...migrations[4],sql:`${migrations[4].sql}\nSELECT missing_migration_function();`}];
        await expect(initializeApplicationSchema(client,failing,await readFile("db/schema.sql","utf8"))).rejects.toThrow("missing_migration_function");
        expect(await preserved(client)).toEqual(before);
        expect((await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='deliveries' AND column_name='last_error'")).rowCount).toBe(1);
        expect(await initializeDatabase(client)).toBe("upgraded");
      } finally {client.release();}
    });
  });
  it("rejects null or untyped JSON facts and monotonically revisions complete delivery state",async()=>{
    await isolated(async pool=>{
      const client=await pool.connect();
      try {
        await initializeDatabase(client);await seed(client);
        const valid={source:"PROVIDER",code:"DELIVERY_FAILED",reasonCode:null,stage:"RECIPIENT_DELIVERY",detailAvailability:"PROVIDER_NOT_SUPPLIED",evidence:{},occurredAt:null};
        for(const field of ["source","code","stage","detailAvailability","evidence"]) {
          const row=(await client.query("SELECT valid_mail_diagnostic($1::jsonb) AS valid",[JSON.stringify({...valid,[field]:null})])).rows[0];expect(row.valid).toBe(false);
        }
        for(const evidence of [{bounceClass:null},{suppressionReason:null},{smtpReplyCode:null},{smtpStatus:null}]) expect((await client.query("SELECT valid_mail_diagnostic($1::jsonb) AS valid",[JSON.stringify({...valid,evidence})])).rows[0].valid).toBe(false);
        for(const value of [null,{owner:null,action:"STOPPED",nextAttemptAt:null},{owner:"PROVIDER",action:"SCHEDULED",nextAttemptAt:null},{owner:"ENVOY",action:"SCHEDULED",nextAttemptAt:"today"},{owner:"ENVOY",action:"SCHEDULED",nextAttemptAt:"2026-02-31T00:00:00Z"}]) expect((await client.query("SELECT valid_mail_retry($1::jsonb) AS valid",[JSON.stringify(value)])).rows[0].valid).toBe(false);
        expect((await client.query("SELECT valid_mail_diagnostic($1::jsonb) AS valid",[JSON.stringify({...valid,occurredAt:"today"})])).rows[0].valid).toBe(false);
        await client.query("UPDATE deliveries SET lifecycle_status='accepted',accepted_at=now() WHERE id='delivery_upgrade'");
        expect((await client.query("SELECT revision::text FROM deliveries WHERE id='delivery_upgrade'")).rows[0].revision).toBe("2");
        await client.query("UPDATE deliveries SET lifecycle_status='accepted',revision=999 WHERE id='delivery_upgrade'");
        expect((await client.query("SELECT revision::text FROM deliveries WHERE id='delivery_upgrade'")).rows[0].revision).toBe("2");
        await client.query("UPDATE deliveries SET diagnostic=$1 WHERE id='delivery_upgrade'",[valid]);
        expect((await client.query("SELECT revision::text FROM deliveries WHERE id='delivery_upgrade'")).rows[0].revision).toBe("3");
      } finally {client.release();}
    });
  });
  it("preserves populated data across repeated setup", async () => {
    await isolated(async pool => {
      const client = await pool.connect();
      try {
        expect(await initializeDatabase(client)).toBe("initialized");
        await seed(client); const before = await preserved(client);
        expect(await initializeDatabase(client)).toBe("validated"); expect(await preserved(client)).toEqual(before);
        const changes = (await client.query("SELECT id,message_id,position::text,recorded_at FROM outbound_changes ORDER BY position")).rows;
        expect(changes.map(row => row.id).sort()).toEqual(["event_upgrade", "submission_event_upgrade"]);
        expect(changes.map(row => row.position)).toEqual(["1", "2"]);
        expect(changes.every(row => row.message_id === "msg_upgrade" && row.recorded_at.getTime() > Date.now() - 10_000)).toBe(true);
        expect((await client.query("SELECT position::text,floor::text FROM outbound_streams WHERE service_id='svc_upgrade'")).rows[0]).toEqual({ position: "2", floor: "0" });
        const journal = (await client.query("SELECT * FROM envoy_meta.migrations ORDER BY file")).rows;
        expect(journal).toHaveLength((await loadApplicationMigrations()).length); expect(await initializeDatabase(client)).toBe("validated");
        expect((await client.query("SELECT * FROM envoy_meta.migrations ORDER BY file")).rows).toEqual(journal);
        await client.query("INSERT INTO delivery_events(id,delivery_id,event_type,source_key,occurred_at,canonical_payload) VALUES('next_event','delivery_upgrade','opened','next-source','1800-01-01','{}')");
        expect((await client.query("SELECT position::text FROM outbound_changes WHERE id='next_event'")).rows[0].position).toBe("3");
      } finally { client.release(); }
    });
  });
  it("serializes concurrent initialization without duplicate journal entries", async () => {
    await isolated(async pool => {
      const first = await pool.connect(), second = await pool.connect();
      try {
        expect((await Promise.all([initializeDatabase(first), initializeDatabase(second)])).sort()).toEqual(["initialized", "validated"]);
        await seed(first);
        expect((await first.query("SELECT count(*)::int AS count FROM envoy_meta.migrations")).rows[0].count).toBe((await loadApplicationMigrations()).length);
        expect((await first.query("SELECT count(*)::int AS count FROM outbound_changes")).rows[0].count).toBe(2);
      } finally { first.release(); second.release(); }
    });
  });
  it("upgrades populated V1 databases without changing retained business data", async () => {
    await isolated(async pool => {
      const client = await pool.connect();
      try {
        const migrations = await loadApplicationMigrations();
        expect(await initializeApplicationSchema(client, migrations.slice(0, 1), migrations[0].sql)).toBe("initialized");
        await seed(client);
        await client.query("INSERT INTO provider_accounts(id,type,name,status,public_config) VALUES('provider_upgrade','mock','Upgrade Provider','active','{}')");
        await client.query("UPDATE sending_domains SET inbound_provider_account_id='provider_upgrade' WHERE id='domain_upgrade'");
        const before = await preserved(client);

        expect(await initializeDatabase(client)).toBe("upgraded");
        expect(await preserved(client)).toEqual(before);
        expect((await client.query("SELECT id,domain FROM sending_domains WHERE id='domain_upgrade'")).rows[0])
          .toEqual({ id: "domain_upgrade", domain: "upgrade.example.test" });
        expect((await client.query("SELECT id FROM provider_accounts WHERE id='provider_upgrade'")).rowCount).toBe(1);
        expect((await client.query("SELECT id FROM service_domain_bindings WHERE id='binding_upgrade'")).rowCount).toBe(1);
        expect((await client.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND table_name='sending_domains' AND column_name='inbound_provider_account_id'")).rows[0].count).toBe(0);
        expect((await client.query("SELECT file FROM envoy_meta.migrations ORDER BY file")).rows.map(row => row.file))
          .toEqual(migrations.map(row => row.file));
        expect(await initializeDatabase(client)).toBe("validated");
      } finally { client.release(); }
    });
  });
  it("rolls back a failed V2 upgrade and can retry", async () => {
    await isolated(async pool => {
      const client = await pool.connect();
      try {
        const migrations = await loadApplicationMigrations();
        await initializeApplicationSchema(client, migrations.slice(0, 1), migrations[0].sql);
        await seed(client);
        const before = await preserved(client);
        const failing = [migrations[0], { ...migrations[1], sql: `${migrations[1].sql}\nSELECT missing_migration_function();` }];
        await expect(initializeApplicationSchema(client, failing, await readFile("db/schema.sql", "utf8"))).rejects.toThrow("missing_migration_function");
        expect(await preserved(client)).toEqual(before);
        expect((await client.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND table_name='sending_domains' AND column_name='inbound_provider_account_id'")).rows[0].count).toBe(1);
        expect((await client.query("SELECT file FROM envoy_meta.migrations ORDER BY file")).rows.map(row => row.file)).toEqual([migrations[0].file]);
        expect(await initializeDatabase(client)).toBe("upgraded");
      } finally { client.release(); }
    });
  });
  it("upgrades populated V2 databases and preserves existing inbound routes", async () => {
    await isolated(async pool => {
      const client = await pool.connect();
      try {
        const migrations = await loadApplicationMigrations();
        await initializeApplicationSchema(client, migrations.slice(0, 2), migrations.slice(0, 2).map(row => row.sql).join("\n"));
        await seed(client);
        await client.query("INSERT INTO provider_accounts(id,type,name,status,public_config) VALUES('provider_upgrade','mock','Upgrade Provider','active','{}')");
        const before = await preserved(client);
        expect(await initializeDatabase(client)).toBe("upgraded");
        expect(await preserved(client)).toEqual(before);
        expect((await client.query("SELECT sending_domain_id,provider_account_id FROM domain_inbound_sources")).rows)
          .toEqual([{sending_domain_id:"domain_upgrade",provider_account_id:"provider_upgrade"}]);
        expect(await initializeDatabase(client)).toBe("validated");
      } finally { client.release(); }
    });
  });
  it("rolls back a failed V3 upgrade and can retry", async () => {
    await isolated(async pool => {
      const client = await pool.connect();
      try {
        const migrations = await loadApplicationMigrations();
        await initializeApplicationSchema(client, migrations.slice(0, 2), migrations.slice(0, 2).map(row => row.sql).join("\n"));
        await seed(client);
        const before = await preserved(client);
        const failing = [...migrations.slice(0, 2), {...migrations[2],sql:`${migrations[2].sql}\nSELECT missing_migration_function();`}];
        await expect(initializeApplicationSchema(client, failing, await readFile("db/schema.sql", "utf8"))).rejects.toThrow("missing_migration_function");
        expect(await preserved(client)).toEqual(before);
        expect((await client.query("SELECT to_regclass('public.domain_inbound_sources') AS sources")).rows[0].sources).toBeNull();
        expect((await client.query("SELECT file FROM envoy_meta.migrations ORDER BY file")).rows.map(row => row.file))
          .toEqual(migrations.slice(0, 2).map(row => row.file));
        expect(await initializeDatabase(client)).toBe("upgraded");
      } finally { client.release(); }
    });
  });
  it("rolls back a failed empty-database initialization and can retry", async () => {
    await isolated(async pool => {
      const client = await pool.connect();
      try {
        const migrations = await loadApplicationMigrations();
        const failing = migrations.map(row => ({ ...row, sql: `${row.sql}\nSELECT missing_migration_function();` }));
        await expect(initializeApplicationSchema(client, failing, await readFile("db/schema.sql", "utf8"))).rejects.toThrow("missing_migration_function");
        expect((await client.query("SELECT to_regclass('public.outbound_changes') AS changes,to_regclass('envoy_meta.migrations') AS journal")).rows[0]).toEqual({ changes: null, journal: null });
        expect(await initializeDatabase(client)).toBe("initialized");
      } finally { client.release(); }
    });
  });
  it("rejects journal checksum drift and unknown migration versions before modifying data", async () => {
    await isolated(async pool => {
      const client = await pool.connect();
      try {
        await initializeDatabase(client); await seed(client); const before = await preserved(client);
        const migrations = await loadApplicationMigrations();
        await client.query("UPDATE envoy_meta.migrations SET sha256='changed' WHERE file=$1", [migrations[0].file]);
        await expect(initializeDatabase(client)).rejects.toThrow("checksum"); expect(await preserved(client)).toEqual(before);
        await client.query("UPDATE envoy_meta.migrations SET sha256=$2 WHERE file=$1", [migrations[0].file, migrations[0].sha256]);
        await client.query("INSERT INTO envoy_meta.migrations(file,sha256) VALUES('999_unknown.sql','unknown')");
        await expect(initializeDatabase(client)).rejects.toThrow("checksum"); expect(await preserved(client)).toEqual(before);
      } finally { client.release(); }
    });
  });
  it("rejects V3 catalog drift before modifying data", async () => {
    await isolated(async pool => {
      const client = await pool.connect();
      try {
        await initializeDatabase(client); await seed(client);
        const before = await preserved(client);
        await client.query("DROP INDEX domain_inbound_sources_provider_account_id_idx");
        await expect(initializeDatabase(client)).rejects.toThrow("Database does not match");
        expect(await preserved(client)).toEqual(before);
      } finally { client.release(); }
    });
  });
  it("rejects an unjournaled populated schema without adopting or altering it", async () => {
    await isolated(async pool => {
      const client = await pool.connect();
      try {
        await client.query(await readFile("db/migrations/001_initial.sql", "utf8"));
        await seed(client); const before = await preserved(client);
        await expect(initializeDatabase(client)).rejects.toThrow("no migration journal");
        expect(await preserved(client)).toEqual(before);
        expect((await client.query("SELECT to_regclass('envoy_meta.migrations') AS journal")).rows[0].journal).toBeNull();
      } finally { client.release(); }
    });
  });
});
