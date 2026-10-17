import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Client, type PoolClient } from "pg";

// An explicit adoption of the reviewed 63f5032 baseline, not a replacement migration chain.
export const baselineChecksum = "7f55d451509eb7abb824d6eb0e9ca29636965ab46495c33abc7eb8199a901533";
export async function adoptSchema(client: Pick<PoolClient,"query">, source: string, apply: boolean) {
  const target = createHash("sha256").update(source).digest("hex");
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('envoy:schema-migrations'))");
    const history = (await client.query<{ name:string; checksum:string }>("SELECT name,checksum FROM schema_migrations ORDER BY name FOR UPDATE")).rows;
    if (history.length !== 1 || history[0].name !== "001_initial.sql") throw new Error("Unrecognized migration history; adoption refused");
    if (history[0].checksum === target) {
      await client.query("SELECT author_date,ingress_received_at,ready_at FROM inbound_messages LIMIT 0");
      await client.query("SELECT position,floor,generation FROM inbound_streams LIMIT 0");
      await client.query("SELECT rfc_message_id FROM submission_attempts LIMIT 0");
      await client.query("SELECT terminated_at FROM raw_provider_events LIMIT 0");
      await client.query("ROLLBACK"); return { state:"already_current",target };
    }
    if (history[0].checksum !== baselineChecksum) throw new Error("Only the reviewed 63f5032 schema is supported; no history is removed or silently accepted");
    const catalog=(await client.query<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='inbound_messages'")).rows.map(row=>row.column_name);
    if (!['delivery_scope','envelope_recipients','references_ids','processing_deadline_at'].every(name=>catalog.includes(name)) || catalog.includes('author_date')) throw new Error("Baseline catalog drift; adoption refused");
    const scope=(await client.query<{indexdef:string}>("SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='inbound_route_scope'")).rows[0];
    if (!scope?.indexdef.includes('service_id')) throw new Error("Baseline inbound route scope index is missing");
    const check = (await client.query<{ active:string; ready:string; uncertain:string }>(`SELECT
      (SELECT count(*) FROM inbound_messages WHERE status='scanning')::text AS active,
      (SELECT count(*) FROM inbound_messages WHERE status='ready' AND service_id IS NOT NULL)::text AS ready,
      (SELECT count(*) FROM submission_attempts WHERE status IN ('submitting','unknown','reconciling'))::text AS uncertain`)).rows[0];
    if (check.active !== "0") throw new Error("Finish or reject scanning copies before adoption; preserve their raw receipts");
    // Lock every affected relation with NOWAIT; operators must stop web/worker/retention processes first.
    await client.query("LOCK TABLE services,inbound_messages,inbound_routes,callback_deliveries,submission_attempts,raw_provider_events IN ACCESS EXCLUSIVE MODE NOWAIT");
    const delivering=(await client.query<{count:string}>("SELECT count(*)::text FROM callback_deliveries WHERE status='delivering'")).rows[0].count;
    if(delivering !== "0") throw new Error("Wait for in-flight callbacks to finish before adoption");
    if (!apply) { await client.query("ROLLBACK"); return { state:"preflight_ok",...check,baseline:baselineChecksum,target }; }
    await client.query(`ALTER TABLE inbound_messages ADD COLUMN author_date timestamptz,ADD COLUMN ingress_received_at timestamptz,ADD COLUMN ready_at timestamptz;
      ALTER TABLE inbound_messages ALTER COLUMN received_at SET DEFAULT clock_timestamp();
      ALTER TABLE submission_attempts ADD COLUMN rfc_message_id text;
      ALTER TABLE raw_provider_events ADD COLUMN terminated_at timestamptz;
      ALTER TABLE callback_deliveries ADD COLUMN terminated_at timestamptz;
      ALTER TABLE callback_deliveries DROP CONSTRAINT callback_deliveries_status_check;
      ALTER TABLE callback_deliveries ADD CHECK(status IN ('pending','delivering','delivered','retrying','dead_letter','terminated'));`);
    const additions = source.slice(source.indexOf("-- Frozen receipt decisions"));
    if (!additions.startsWith("-- Frozen receipt decisions")) throw new Error("Authoritative schema additions not found");
    await client.query(additions);
    // Do not manufacture author dates, trusted ingress times or historical ready times.
    // Freeze old decision scopes without guessing recipients or replaying mail into new services.
    await client.query(`INSERT INTO inbound_receipts(provider_account_id,external_message_id,routes,ingress_received_at)
      SELECT provider_account_id,external_message_id,'[]'::jsonb,min(created_at)
      FROM inbound_messages WHERE external_message_id IS NOT NULL GROUP BY provider_account_id,external_message_id`);
    // Baseline availability is observed at adoption; recorded_at is not a historical receive/ready assertion.
    const retained = (await client.query<{ id:string;service_id:string }>("SELECT id,service_id FROM inbound_messages WHERE service_id IS NOT NULL AND status='ready' AND content_purged_at IS NULL ORDER BY service_id,id")).rows;
    for (const row of retained) {
      await client.query("INSERT INTO inbound_streams(service_id) VALUES($1) ON CONFLICT DO NOTHING",[row.service_id]);
      await client.query(`WITH position AS (UPDATE inbound_streams SET position=position+1 WHERE service_id=$1 RETURNING position)
        INSERT INTO inbound_changes(service_id,position,inbound_message_id,type) SELECT $1,position,$2,'inbound.available' FROM position`,[row.service_id,row.id]);
    }
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES('schema-adoption','schema.adopt','schema','001_initial.sql',$1)",[{ baseline:baselineChecksum,target,legacyReadyCopies:retained.length,unverifiedHistoricalTimes:true }]);
    // Retain the ledger row, including its original applied_at. The audit preserves both checksums.
    await client.query("UPDATE schema_migrations SET checksum=$1 WHERE name='001_initial.sql' AND checksum=$2",[target,baselineChecksum]);
    await client.query("COMMIT");
    return { state:"adopted",target,legacyReadyCopies:retained.length };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function main() {
  // Deliberately do not load .env.local or fall back to a developer/production URL.
  const url = process.env.ENVOY_ADOPTION_DATABASE_URL;
  if (!url) throw new Error("Set the dedicated ENVOY_ADOPTION_DATABASE_URL explicitly; default action is read-only preflight");
  const apply = process.argv.includes("--apply");
  if (apply && !process.argv.includes("--processes-stopped-and-backup-verified")) throw new Error("Apply requires --processes-stopped-and-backup-verified");
  const source = await readFile(new URL("../db/migrations/001_initial.sql",import.meta.url),"utf8");
  const client = new Client({ connectionString:url,statement_timeout:30000 });
  await client.connect();
  try { console.log(JSON.stringify(await adoptSchema(client,source,apply))); } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error=>{
  console.error(error instanceof Error ? error.message : "Schema adoption failed");process.exitCode=1;
});
