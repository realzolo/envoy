import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";
import { initializeV1 } from "@/platform/database/initialization";
import { database, query, transaction, transactionClient, transactionContext } from "@/platform/database";
import { products } from "@/platform/database/schema";
import type { TransactionContext } from "@/platform/transactions";
import { checkBaseline } from "../../db/baseline";
import { schemaDocumentation } from "@/platform/database/schema/documentation";

describe("V1 database foundation", () => {
  it("keeps the single baseline identical to typed schema and native database behaviors", async () => {
    expect(await checkBaseline()).toBe(await readFile("db/migrations/001_initial.sql", "utf8"));
  });

  it("initializes empty databases, validates V1 and refuses schema drift without modifying existing objects", async () => {
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
      expect(await initializeV1(client)).toBe("initialized");
      expect(await initializeV1(client)).toBe("validated");
      expect((await client.query("SELECT to_regclass('public.schema_migrations') AS journal")).rows[0].journal).toBeNull();
      const descriptions = await client.query<{ table_count: string; column_count: string; described_tables: string; described_columns: string }>(`
        SELECT count(DISTINCT c.oid)::text AS table_count,count(*)::text AS column_count,
          count(DISTINCT c.oid) FILTER (WHERE nullif(btrim(obj_description(c.oid,'pg_class')),'') IS NOT NULL)::text AS described_tables,
          count(*) FILTER (WHERE nullif(btrim(col_description(c.oid,a.attnum)),'') IS NOT NULL)::text AS described_columns
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`);
      const tableCount = Object.keys(schemaDocumentation).length.toString();
      const columnCount = Object.values(schemaDocumentation).reduce((count, entry) => count + Object.keys(entry.columns).length, 0).toString();
      expect(descriptions.rows[0]).toEqual({ table_count: tableCount, column_count: columnCount, described_tables: tableCount, described_columns: columnCount });
      await client.query("COMMENT ON TABLE products IS 'unexpected table description'");
      await expect(initializeV1(client)).rejects.toThrow("does not match");
      expect((await client.query("SELECT obj_description('products'::regclass,'pg_class') AS description")).rows[0].description).toBe("unexpected table description");
      await client.query(`COMMENT ON TABLE products IS '${schemaDocumentation.products.table.replaceAll("'", "''")}'`);
      await client.query("COMMENT ON COLUMN products.name IS NULL");
      await expect(initializeV1(client)).rejects.toThrow("does not match");
      expect((await client.query("SELECT col_description('products'::regclass,2) AS description")).rows[0].description).toBeNull();
      await client.query(`COMMENT ON COLUMN products.name IS '${schemaDocumentation.products.columns.name.replaceAll("'", "''")}'`);
      expect(await initializeV1(client)).toBe("validated");
      await client.query("CREATE TYPE public.unexpected_status AS ENUM ('new')");
      await expect(initializeV1(client)).rejects.toThrow("does not match");
      await client.query("DROP TYPE public.unexpected_status");
      await client.query("ALTER TABLE services DROP CONSTRAINT services_configuration_revision_check");
      await expect(initializeV1(client)).rejects.toThrow("does not match");
      expect((await client.query("SELECT count(*) AS count FROM pg_namespace WHERE nspname LIKE 'envoy_v1_%'")).rows[0].count).toBe("0");
      // The rejected initializer must not restore, remove or otherwise change the existing schema.
      expect((await client.query("SELECT count(*) AS count FROM pg_constraint WHERE conname='services_configuration_revision_check'")).rows[0].count).toBe("0");
    } finally {
      client.release();
      await isolatedPool.end();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it("shares a real transaction across typed repositories, rolls back atomically and expires its opaque context", async () => {
    const id = `prd_transaction_${randomUUID()}`;
    let context: TransactionContext | undefined;
    await expect(transaction(async client => {
      context = transactionContext(client);
      expect(transactionClient(context)).toBe(client);
      await database(client).insert(products).values({ id, name: id });
      throw new Error("rollback this use case");
    })).rejects.toThrow("rollback this use case");
    expect((await query("SELECT id FROM products WHERE id=$1", [id])).rowCount).toBe(0);
    expect(() => transactionClient(context!)).toThrow("expired");
  });
});
