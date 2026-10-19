import { execFileSync } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { getTableColumns, getTableName, type Table } from "drizzle-orm";
import * as schema from "../src/platform/database/schema";
import { databaseBehaviors } from "../src/platform/database/schema/behaviors";
import { schemaCommentsSql } from "../src/platform/database/schema/documentation";
import { loadApplicationMigrations } from "./migrations";

const header = `-- Envoy application schema, generated from typed Drizzle definitions.
-- This snapshot is checked against the cumulative ordered migrations.
-- ALTER statements below declare final foreign keys, including circular references.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

`;

/** The exporter may report compilation errors with exit code zero; never publish incomplete SQL. */
export function assertCompleteSchema(exported: string) {
  const definitions = new Map([...exported.matchAll(/CREATE TABLE "([^"]+)" \(([\s\S]*?)\n\);/g)].map(match => [match[1], match[2]]));
  const tables = Object.values(schema) as Table[];
  if (definitions.size !== tables.length) throw new Error("Schema export is incomplete: table count differs from typed definitions");
  for (const table of tables) {
    const name = getTableName(table), definition = definitions.get(name);
    if (!definition) throw new Error(`Schema export is missing table ${name}`);
    const columns = new Set([...definition.matchAll(/^\s*"([^"]+)"\s/gm)].map(match => match[1]));
    const expected = Object.values(getTableColumns(table)).map(column => column.name);
    if (columns.size !== expected.length || expected.some(column => !columns.has(column))) throw new Error(`Schema export columns do not match ${name}`);
  }
}

export async function baselineSql(root = process.cwd()) {
  const exported = execFileSync(process.execPath, [join(root, "node_modules/drizzle-kit/bin.cjs"), "export", "--config=drizzle.config.ts"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  assertCompleteSchema(exported);
  return header + exported.trim() + "\n\n" + databaseBehaviors + "\n" + schemaCommentsSql();
}

export async function checkBaseline(root = process.cwd()) {
  await loadApplicationMigrations(root);
  const actual = await readFile(join(root, "db/schema.sql"), "utf8");
  if (actual !== await baselineSql(root)) throw new Error("Schema snapshot differs from typed definitions. Run pnpm db:generate, then add an ordered migration matching the change.");
  return actual;
}
async function main() {
  if (process.argv.includes("--write")) {
    await loadApplicationMigrations();
    const sql = await baselineSql(), target = join(process.cwd(), "db/schema.sql"), temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, sql); await rename(temporary, target);
    console.log("Generated schema snapshot; application migrations remain unchanged");
  } else { await checkBaseline(); console.log("Typed schema snapshot and ordered migration checksums verified"); }
}
if (process.argv[1]?.endsWith("db/baseline.ts")) void main().catch(error => { console.error(error); process.exitCode = 1; });
