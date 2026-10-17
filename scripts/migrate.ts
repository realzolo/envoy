import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import { runMigrations } from "bullmq";
import { db } from "../src/server/database";

loadEnvConfig(process.cwd());

async function main() {
  const migrationsDirectory = join(process.cwd(), "db", "migrations");
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const client = await db().connect();
  let hasMigrationLock = false;

  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", ["envoy:schema-migrations"]);
    hasMigrationLock = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const file of migrationFiles) {
      const sql = await readFile(join(migrationsDirectory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const applied = await client.query<{ checksum: string | null }>("SELECT checksum FROM schema_migrations WHERE name = $1", [file]);
      if (applied.rowCount) {
        const appliedChecksum = applied.rows[0].checksum;
        if (appliedChecksum !== checksum) {
          throw new Error(`Migration checksum mismatch for ${file}. Use the reviewed schema adoption procedure in docs/OPERATIONS.md; never reset data or edit the ledger manually.`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)", [file, checksum]);
        await client.query("COMMIT");
        console.log(`Applied ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    const queueVersion = await runMigrations(client, "bullmq");
    console.log(`BullMQ PostgreSQL schema ready (version ${queueVersion})`);
  } finally {
    if (hasMigrationLock) await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["envoy:schema-migrations"]);
    client.release();
    await db().end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
