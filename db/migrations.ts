import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type ApplicationMigration = { file: string; sha256: string; sql: string };
export async function loadApplicationMigrations(root = process.cwd()): Promise<ApplicationMigration[]> {
  const directory = join(root, "db/migrations");
  const manifest: { file: string; sha256: string }[] = JSON.parse(await readFile(join(directory, "checksums.json"), "utf8"));
  const files = (await readdir(directory)).filter(file => file.endsWith(".sql")).sort();
  if (!Array.isArray(manifest) || !manifest.length || JSON.stringify(files) !== JSON.stringify(manifest.map(row => row.file))) throw new Error("Migration files do not match the ordered checksum manifest");
  const result: ApplicationMigration[] = [];
  for (const [index, entry] of manifest.entries()) {
    if (!new RegExp(`^${String(index + 1).padStart(3, "0")}_[a-z0-9_]+\\.sql$`).test(entry.file)) throw new Error("Migration versions must be contiguous and ordered");
    const sql = await readFile(join(directory, entry.file), "utf8");
    if (createHash("sha256").update(sql).digest("hex") !== entry.sha256) throw new Error(`Migration checksum mismatch: ${entry.file}`);
    result.push({ ...entry, sql });
  }
  return result;
}
