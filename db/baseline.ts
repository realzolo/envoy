import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { databaseBehaviors } from "../src/platform/database/schema/behaviors";
import { schemaCommentsSql } from "../src/platform/database/schema/documentation";

const header = `-- Envoy V1: complete application schema, generated from typed Drizzle definitions.
-- Before V1 release, regenerate this file instead of adding migrations.
-- ALTER statements below declare final foreign keys, including circular references.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

`;

export async function baselineSql(root = process.cwd()) {
  const exported = execFileSync(process.execPath, [join(root, "node_modules/drizzle-kit/bin.cjs"), "export", "--config=drizzle.config.ts"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return header + exported.trim() + "\n\n" + databaseBehaviors + "\n" + schemaCommentsSql();
}

export async function checkBaseline(root = process.cwd()) {
  const files = (await readdir(join(root, "db/migrations"))).filter(file => file.endsWith(".sql"));
  if (files.length !== 1 || files[0] !== "001_initial.sql") throw new Error("V1 must contain only db/migrations/001_initial.sql");
  const actual = await readFile(join(root, "db/migrations/001_initial.sql"), "utf8");
  if (actual !== await baselineSql(root)) throw new Error("V1 differs from Drizzle schema, business descriptions or database behaviors. Run pnpm db:generate and review the complete V1.");
  return actual;
}

async function main() {
  if (process.argv.includes("--write")) {
    await writeFile(join(process.cwd(), "db/migrations/001_initial.sql"), await baselineSql());
    console.log("Generated the complete V1 schema");
  } else {
    await checkBaseline();
    console.log("V1 matches all typed tables, columns, business descriptions, constraints, indexes and database behaviors");
  }
}

if (process.argv[1]?.endsWith("db/baseline.ts")) void main().catch(error => { console.error(error); process.exitCode = 1; });
