import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";
import { initializeDatabase } from "@/platform/database/initialization";
import { applicationSchemaHealth, database, query, transaction, transactionClient, transactionContext } from "@/platform/database";
import { services } from "@/platform/database/schema";
import type { TransactionContext } from "@/platform/transactions";
import { assertCompleteSchema, checkBaseline } from "../../db/baseline";
import { schemaDocumentation } from "@/platform/database/schema/documentation";

describe("database migration foundation", () => {
  it("keeps the schema snapshot identical to typed definitions and native behaviors", async () => {
    expect(await checkBaseline()).toBe(await readFile("db/schema.sql", "utf8"));
  });

  it("initializes empty databases, validates the schema and refuses schema drift without modifying existing objects", async () => {
    const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? "postgresql://envoy:envoy@localhost:5432/postgres";
    const name = `envoy_foundation_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    const isolatedPool = new Pool({ connectionString: url.toString() });
    const client = await isolatedPool.connect();
    try {
      expect(await initializeDatabase(client)).toBe("initialized");
      expect(await initializeDatabase(client)).toBe("validated");
      expect((await client.query("SELECT to_regclass('envoy_meta.migrations') AS journal")).rows[0].journal).toBe("envoy_meta.migrations");
      const descriptions = await client.query<{ table_count: string; column_count: string; described_tables: string; described_columns: string }>(`
        SELECT count(DISTINCT c.oid)::text AS table_count,count(*)::text AS column_count,
          count(DISTINCT c.oid) FILTER (WHERE nullif(btrim(obj_description(c.oid,'pg_class')),'') IS NOT NULL)::text AS described_tables,
          count(*) FILTER (WHERE nullif(btrim(col_description(c.oid,a.attnum)),'') IS NOT NULL)::text AS described_columns
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`);
      const tableCount = Object.keys(schemaDocumentation).length.toString();
      const columnCount = Object.values(schemaDocumentation).reduce((count, entry) => count + Object.keys(entry.columns).length, 0).toString();
      expect(descriptions.rows[0]).toEqual({ table_count: tableCount, column_count: columnCount, described_tables: tableCount, described_columns: columnCount });
      await client.query("COMMENT ON TABLE services IS 'unexpected table description'");
      await expect(initializeDatabase(client)).rejects.toThrow("does not match");
      expect((await client.query("SELECT obj_description('services'::regclass,'pg_class') AS description")).rows[0].description).toBe("unexpected table description");
      await client.query(`COMMENT ON TABLE services IS '${schemaDocumentation.services.table.replaceAll("'", "''")}'`);
      await client.query("COMMENT ON COLUMN services.name IS NULL");
      await expect(initializeDatabase(client)).rejects.toThrow("does not match");
      expect((await client.query("SELECT col_description('services'::regclass,2) AS description")).rows[0].description).toBeNull();
      await client.query(`COMMENT ON COLUMN services.name IS '${schemaDocumentation.services.columns.name.replaceAll("'", "''")}'`);
      expect(await initializeDatabase(client)).toBe("validated");
      await client.query("CREATE TYPE public.unexpected_status AS ENUM ('new')");
      await expect(initializeDatabase(client)).rejects.toThrow("does not match");
      await client.query("DROP TYPE public.unexpected_status");
      await client.query("ALTER TABLE services DROP CONSTRAINT services_configuration_revision_check");
      await expect(initializeDatabase(client)).rejects.toThrow("does not match");
      expect((await client.query("SELECT count(*) AS count FROM pg_namespace WHERE nspname LIKE 'envoy_schema_%'")).rows[0].count).toBe("0");
      // The rejected initializer must not restore, remove or otherwise change the existing schema.
      expect((await client.query("SELECT count(*) AS count FROM pg_constraint WHERE conname='services_configuration_revision_check'")).rows[0].count).toBe("0");
    } finally {
      client.release();
      await isolatedPool.end();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    }
  }, 30_000);

  it("records the reset V1 SQL checksum", async () => {
    expect(createHash("sha256").update(await readFile("db/migrations/001_initial.sql")).digest("hex")).toBe("1b5746e8d7aeed5d6520d2487ee50cda0f8d9a7876a1b22dde204359243ebf2c");
  });

  it("allows multiple Services to receive the same domain through separate bindings", async () => {
    const serviceId = `svc_second_${randomUUID()}`;
    await expect(transaction(async client => {
      await client.query("INSERT INTO services(id,name) VALUES($1,$1)", [serviceId]);
      await client.query("INSERT INTO service_domain_bindings(id,service_id,sending_domain_id,receive_enabled) VALUES($1,$2,'sd_atlas',true)", [`binding_${randomUUID()}`, serviceId]);
      const result = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM service_domain_bindings WHERE sending_domain_id='sd_atlas' AND receive_enabled");
      expect(result.rows[0].count).toBe(2);
      throw new Error("discard test binding");
    })).rejects.toThrow("discard test binding");
  });

  it("rejects incomplete exporter output before snapshot publication", async () => {
    const sql = await readFile("db/schema.sql", "utf8");
    expect(() => assertCompleteSchema(sql)).not.toThrow();
    expect(() => assertCompleteSchema("Compilation failed")).toThrow("incomplete");
    expect(() => assertCompleteSchema(sql.replace(/CREATE TABLE "messages" \([\s\S]*?\n\);/, ""))).toThrow("incomplete");
    expect(() => assertCompleteSchema(sql.replace('\t"subject" text NOT NULL,', ""))).toThrow("columns");
  });

  it("requires current migration records for runtime readiness", async () => {
    await applicationSchemaHealth();
    const row = (await query<{ file: string; sha256: string; applied_at: Date }>("SELECT * FROM envoy_meta.migrations ORDER BY file DESC LIMIT 1")).rows[0];
    await query("DELETE FROM envoy_meta.migrations WHERE file=$1", [row.file]);
    try { await expect(applicationSchemaHealth()).rejects.toThrow("migrations are required"); }
    finally { await query("INSERT INTO envoy_meta.migrations(file,sha256,applied_at) VALUES($1,$2,$3)", [row.file, row.sha256, row.applied_at]); }
    await applicationSchemaHealth();
  });

  it("shares a real transaction across typed repositories, rolls back atomically and expires its opaque context", async () => {
    const id = `svc_transaction_${randomUUID()}`;
    let context: TransactionContext | undefined;
    await expect(transaction(async client => {
      context = transactionContext(client);
      expect(transactionClient(context)).toBe(client);
      await database(client).insert(services).values({ id, name: id });
      throw new Error("rollback this use case");
    })).rejects.toThrow("rollback this use case");
    expect((await query("SELECT id FROM services WHERE id=$1", [id])).rowCount).toBe(0);
    expect(() => transactionClient(context!)).toThrow("expired");
  });
});
