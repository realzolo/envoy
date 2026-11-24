import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { initializeApplicationSchema, initializeDatabase } from "@/platform/database/initialization";
import { loadApplicationMigrations } from "../../db/migrations";
vi.setConfig({ testTimeout: 30_000 });

async function isolated(work: (pool: Pool) => Promise<void>) {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL!, name = `envoy_reader_migration_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  try { await work(pool); }
  finally { await pool.end(); await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end(); }
}

describe("V8 unified reader migration", () => {
  it("upgrades populated V7 without changing source facts, validates replay and rejects drift/checksum changes", async () => {
    await isolated(async pool => {
      const client = await pool.connect();
      try {
        const migrations = await loadApplicationMigrations(), prior = migrations.slice(0, 7);
        expect(migrations).toHaveLength(8);
        await initializeApplicationSchema(client, prior, prior.map(item => item.sql).join("\n"));
        await client.query("INSERT INTO services(id,name) VALUES('svc_reader_upgrade','Reader upgrade')");
        await client.query("INSERT INTO provider_accounts(id,type,name,public_config) VALUES('pa_reader_upgrade','mock','Reader source','{}')");
        await client.query(`INSERT INTO inbound_messages(id,service_id,provider_account_id,external_message_id,delivery_scope,envelope_recipients,from_email,to_emails,subject,sanitized_html,text_body,status)
          VALUES('inb_reader_upgrade','svc_reader_upgrade','pa_reader_upgrade','original-native-id','svc_reader_upgrade',ARRAY['inbox@example.test'],'author@example.test',ARRAY['inbox@example.test'],'Retained subject','<table><tr><td>Original HTML</td></tr></table>','Original text','ready')`);
        await client.query(`INSERT INTO inbound_document_resources(id,inbound_message_id,document_revision,metadata,source,cached_content,content_type,size_bytes,sha256,scan_policy,state,lease_token,lease_expires_at)
          VALUES('idr_reader_old','inb_reader_upgrade',1,'{"kind":"REMOTE"}','{"retained":"original-reference"}','{"old":"encrypted-cache"}','image/png',10,$1,'old-policy','READY','old-lease',now()+interval '1 minute')`,["a".repeat(64)]);
        const source = (await client.query("SELECT to_jsonb(i) AS value FROM inbound_messages i WHERE id='inb_reader_upgrade'")).rows[0].value;
        expect(await initializeDatabase(client)).toBe("upgraded");
        expect((await client.query("SELECT to_jsonb(i) AS value FROM inbound_messages i WHERE id='inb_reader_upgrade'")).rows[0].value).toEqual(source);
        expect((await client.query("SELECT count(*)::int AS count FROM mail_reader_resources")).rows[0].count).toBe(0);
        const oldResource=(await client.query("SELECT metadata,source,cached_content,sha256,scan_policy,lease_token,lease_expires_at,state,reason_code FROM inbound_document_resources WHERE id='idr_reader_old'")).rows[0];
        expect(oldResource).toEqual({metadata:{kind:"REMOTE"},source:{retained:"original-reference"},cached_content:null,sha256:null,scan_policy:null,lease_token:null,lease_expires_at:null,state:"PREPARING",reason_code:"NOT_READY"});
        expect(await initializeDatabase(client)).toBe("validated");
        await client.query("ALTER TABLE mail_reader_resources ADD COLUMN unexpected_reader_column text");
        await expect(initializeDatabase(client)).rejects.toThrow("does not match");
        await client.query("ALTER TABLE mail_reader_resources DROP COLUMN unexpected_reader_column");
        await client.query("UPDATE envoy_meta.migrations SET sha256='modified' WHERE file=$1", [migrations[7].file]);
        await expect(initializeDatabase(client)).rejects.toThrow("checksum or order differs");
        await client.query("UPDATE envoy_meta.migrations SET sha256=$2 WHERE file=$1", [migrations[7].file, migrations[7].sha256]);
        expect(await initializeDatabase(client)).toBe("validated");
      } finally { client.release(); }
    });
  });
  it("rolls back all V8 objects and comments on late failure and permits the same upgrade to retry", async () => {
    await isolated(async pool => {
      const client = await pool.connect();
      try {
        const migrations = await loadApplicationMigrations(), prior = migrations.slice(0, 7);
        await initializeApplicationSchema(client, prior, prior.map(item => item.sql).join("\n"));
        const failed = [...prior, { ...migrations[7], sql: `${migrations[7].sql}\nSELECT missing_reader_upgrade_function();` }];
        await expect(initializeApplicationSchema(client, failed, await readFile("db/schema.sql", "utf8"))).rejects.toThrow("missing_reader_upgrade_function");
        expect((await client.query("SELECT to_regclass('public.mail_reader_resources') AS reader")).rows[0].reader).toBeNull();
        expect((await client.query("SELECT count(*)::int AS count FROM pg_proc WHERE proname='erase_mail_reader_resources'")).rows[0].count).toBe(0);
        expect((await client.query("SELECT count(*)::int AS count FROM envoy_meta.migrations")).rows[0].count).toBe(7);
        expect(await initializeDatabase(client)).toBe("upgraded");
        expect(await initializeDatabase(client)).toBe("validated");
      } finally { client.release(); }
    });
  });
});
