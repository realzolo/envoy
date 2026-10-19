import { loadEnvConfig } from "@next/env";
import { db } from "../src/platform/database";
import { retentionOptions, runRetention } from "../src/platform/retention/public";

loadEnvConfig(process.cwd());
async function main() {
  const args = process.argv.slice(2);
  if (args.some(argument => argument !== "--apply")) throw new Error("Usage: pnpm data:cleanup [--apply] (defaults to dry-run)");
  try {
    const options = retentionOptions(process.env, args.includes("--apply"));
    const result = await runRetention(options);
    console.log(JSON.stringify({ mode: options.apply ? "apply" : "dry-run", batchSize: options.batchSize, result }, null, 2));
    if (Object.values(result).some(item => item.failed)) process.exitCode = 1;
  } finally { await db().end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
