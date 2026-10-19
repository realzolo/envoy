import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { assertSchemaCompatibility, runMigrations } from "bullmq";

/** Full catalog comparison: no application migration journal, checksum marker or historical patches. */
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

export async function initializeApplicationSchema(client: PoolClient, sql: string) {
  const namespace = `envoy_v1_${randomUUID().replaceAll("-", "")}`;
  await client.query("BEGIN");
  try {
    // An empty database may lack pgcrypto. PostgreSQL also provides gen_random_uuid natively.
    // Install official extension only after the target has been identified as empty or valid V1.
    await client.query(`CREATE SCHEMA "${namespace}"`);
    await client.query(`SET LOCAL search_path TO "${namespace}", pg_catalog`);
    const isolatedSql = sql.replace(/^CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/m, "")
      .replaceAll('"public".', `"${namespace}".`);
    await client.query(isolatedSql);
    const expected = await catalog(client, namespace);
    const actual = await catalog(client, "public");
    if (actual.length && JSON.stringify(actual) !== JSON.stringify(expected)) {
      if (process.env.DEBUG_V1_SCHEMA) console.error({ missing: expected.filter(x => !actual.includes(x)), extra: actual.filter(x => !expected.includes(x)) });
      throw new Error("Database does not match the complete Envoy V1 schema. Use a new empty database; this initializer never upgrades or resets existing schemas.");
    }
    await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
    await client.query("SET LOCAL search_path TO public, pg_catalog");
    if (!actual.length) await client.query(sql);
    await client.query("COMMIT");
    return actual.length ? "validated" : "initialized";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** Used by setup and tests; runtime Web/Worker never execute DDL. */
export async function initializeV1(client: PoolClient, root = process.cwd()) {
  const sql = await readFile(join(root, "db/migrations/001_initial.sql"), "utf8");
  await client.query("SELECT pg_advisory_lock(hashtext($1))", ["envoy:v1-initialization"]);
  try {
    const status = await initializeApplicationSchema(client, sql);
    await runMigrations(client, "bullmq");
    await assertSchemaCompatibility(client, "bullmq");
    return status;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["envoy:v1-initialization"]);
  }
}
