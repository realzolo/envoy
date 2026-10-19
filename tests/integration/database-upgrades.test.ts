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
  try { await work(pool); }
  finally { await pool.end(); await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end(); }
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
    'delivery',(SELECT to_jsonb(d) FROM deliveries d WHERE id='delivery_upgrade'),
    'event',(SELECT to_jsonb(e) FROM delivery_events e WHERE id='event_upgrade'),
    'submissionEvent',(SELECT to_jsonb(e) FROM submission_events e WHERE id='submission_event_upgrade')) AS facts`)).rows[0].facts;
}

describe("application database migrations", () => {
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
        expect(journal).toHaveLength(3); expect(await initializeDatabase(client)).toBe("validated");
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
        expect((await first.query("SELECT count(*)::int AS count FROM envoy_meta.migrations")).rows[0].count).toBe(3);
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
