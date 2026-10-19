import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { assertSchemaCompatibility, runMigrations } from "bullmq";
import { loadApplicationMigrations, type ApplicationMigration } from "../../../db/migrations";

/** Compare complete application objects independently of their deployment namespace. */
async function catalog(client: PoolClient, namespace: string) {
  await client.query(`SET LOCAL search_path TO "${namespace}", pg_catalog`);
  const result = await client.query<{ object: unknown }>(`
    SELECT jsonb_build_object('kind','relation','name',c.relname,'type',c.relkind,'description',obj_description(c.oid,'pg_class'),
      'persistence',c.relpersistence,'rowSecurity',c.relrowsecurity,'forceRowSecurity',c.relforcerowsecurity) AS object
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','S')
    UNION ALL
    SELECT jsonb_build_object('kind','type','name',t.typname,'type',t.typtype,
      'base',format_type(t.typbasetype,t.typtypmod),'required',t.typnotnull,'default',t.typdefault,
      'labels',(SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid))
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname=$1 AND t.typtype IN ('e','d','r','m')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
    UNION ALL
    SELECT jsonb_build_object('kind','sequence','name',c.relname,'type',format_type(s.seqtypid,NULL),
      'start',s.seqstart,'increment',s.seqincrement,'min',s.seqmin,'max',s.seqmax,'cache',s.seqcache,'cycle',s.seqcycle)
      FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1
    UNION ALL
    SELECT jsonb_build_object('kind','policy','table',c.relname,'name',p.polname,
      'command',p.polcmd,'permissive',p.polpermissive,'roles',p.polroles,
      'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))
      FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1
    UNION ALL
    SELECT jsonb_build_object('kind','column','table',c.relname,'name',a.attname,
      'position',a.attnum,'type',format_type(a.atttypid,a.atttypmod),'required',a.attnotnull,'description',col_description(c.oid,a.attnum),
      'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated)
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL
    SELECT jsonb_build_object('kind','constraint','table',c.relname,'name',k.conname,'definition',pg_get_constraintdef(k.oid))
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
    UNION ALL
    SELECT jsonb_build_object('kind','index','table',t.relname,'name',c.relname,'definition',pg_get_indexdef(c.oid),'valid',i.indisvalid)
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1
    UNION ALL
    SELECT jsonb_build_object('kind','trigger','table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND NOT t.tgisinternal
    UNION ALL
    SELECT jsonb_build_object('kind','function','name',p.proname,'definition',pg_get_functiondef(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
  `, [namespace]);
  return result.rows.map(row => JSON.stringify(row.object)
    .replaceAll(`\\"${namespace}\\".`, "__application__.")
    .replaceAll(`${namespace}.`, "__application__.")
    .replaceAll("pg_catalog.gen_random_uuid()", "gen_random_uuid()"))
    .sort();
}

async function expectedCatalog(client: PoolClient, sql: string) {
  const namespace = `envoy_schema_${randomUUID().replaceAll("-", "")}`;
  await client.query(`CREATE SCHEMA "${namespace}"`);
  await client.query(`SET LOCAL search_path TO "${namespace}", pg_catalog`);
  await client.query(sql.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/m, "")
    .replaceAll('"public".', `"${namespace}".`)
    .replace(/^LOCK TABLE .*;$/gm, ""));
  const result = await catalog(client, namespace);
  await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
  await client.query("SET LOCAL search_path TO public, pg_catalog");
  return result;
}
function equalCatalog(actual: string[], expected: string[]) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    if (process.env.DEBUG_DATABASE_SCHEMA) console.error({ missing: expected.filter(x => !actual.includes(x)), extra: actual.filter(x => !expected.includes(x)) });
    throw new Error("Database does not match its recorded application schema; migration refused without changing existing objects");
  }
}

export async function initializeApplicationSchema(client: PoolClient, migrations: ApplicationMigration[], snapshot: string) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["envoy:application-migrations"]);
    const actual = await catalog(client, "public"), empty = !actual.length;
    const hasJournal = (await client.query("SELECT to_regclass('envoy_meta.migrations') AS journal")).rows[0].journal;
    const applied: { file: string; sha256: string }[] = hasJournal ? (await client.query<{ file: string; sha256: string }>("SELECT file,sha256 FROM envoy_meta.migrations ORDER BY file")).rows : [];
    if (applied.length > migrations.length || applied.some((row, index) => row.file !== migrations[index].file || row.sha256 !== migrations[index].sha256)) throw new Error("Applied migration checksum or order differs from the repository");
    let count = applied.length;
    if (!empty && !count) {
      equalCatalog(actual, await expectedCatalog(client, migrations[0].sql));
      count = 1;
    } else if (count) equalCatalog(actual, await expectedCatalog(client, migrations.slice(0, count).map(row => row.sql).join("\n")));
    if (empty && count) throw new Error("Application schema is missing despite recorded migrations");
    if (!hasJournal) await client.query(`CREATE SCHEMA IF NOT EXISTS envoy_meta;
      CREATE TABLE IF NOT EXISTS envoy_meta.migrations(file text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
      COMMENT ON TABLE envoy_meta.migrations IS 'Applied application migration checksums; deployments append ordered immutable SQL';
      COMMENT ON COLUMN envoy_meta.migrations.file IS 'Applied ordered SQL migration filename';
      COMMENT ON COLUMN envoy_meta.migrations.sha256 IS 'SHA-256 digest of the exact executed SQL';
      COMMENT ON COLUMN envoy_meta.migrations.applied_at IS 'Database time when the version was recorded';`);
    if (!applied.length && count) await client.query("INSERT INTO envoy_meta.migrations(file,sha256) VALUES($1,$2)", [migrations[0].file, migrations[0].sha256]);
    const start = count;
    for (const migration of migrations.slice(count)) {
      await client.query(migration.sql);
      await client.query("INSERT INTO envoy_meta.migrations(file,sha256) VALUES($1,$2)", [migration.file, migration.sha256]);
      count++;
    }
    const result = await catalog(client, "public");
    equalCatalog(result, await expectedCatalog(client, snapshot));
    await client.query("COMMIT");
    return empty ? "initialized" : count > start ? "upgraded" : "validated";
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

/** Setup owns DDL; running Web and Worker processes only check readiness. */
export async function initializeDatabase(client: PoolClient, root = process.cwd()) {
  const migrations = await loadApplicationMigrations(root), snapshot = await readFile(join(root, "db/schema.sql"), "utf8");
  const status = await initializeApplicationSchema(client, migrations, snapshot);
  await runMigrations(client, "bullmq");
  await assertSchemaCompatibility(client, "bullmq");
  return status;
}
