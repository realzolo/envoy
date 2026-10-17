import type { PoolClient } from "pg";
import { objectStore, type ObjectStore } from "@/modules/config/object-store";
import { query } from "@/server/database";

export async function registerObjectUpload(key: string) {
  await query(`INSERT INTO pending_object_deletions(object_key,available_at) VALUES ($1,now()+interval '10 minutes')
    ON CONFLICT(object_key) DO UPDATE SET available_at=EXCLUDED.available_at`, [key]);
}

// The intent and new database references commit together. Missing intents fence expired uploads.
export async function completeObjectUploads(client: PoolClient, keys: string[]) {
  const unique = [...new Set(keys)].sort();
  if (!unique.length) return;
  const result = await client.query("DELETE FROM pending_object_deletions WHERE object_key=ANY($1::text[]) RETURNING object_key", [unique]);
  if (result.rowCount !== unique.length) throw new Error("Object upload claim expired before its references could be committed; retry processing");
}

export async function cleanupOrphanObjects(client: PoolClient, apply: boolean, limit: number, store?: ObjectStore) {
  const candidates = await client.query<{ object_key: string }>(
    "SELECT object_key FROM pending_object_deletions WHERE available_at<=now() ORDER BY available_at,object_key LIMIT $1", [limit],
  );
  const result = { enabled: true, eligible: candidates.rowCount ?? 0, applied: 0, failed: 0 };
  if (!apply) return result;
  for (const { object_key: key } of candidates.rows) {
    await client.query("BEGIN");
    try {
      const claim = await client.query("SELECT object_key FROM pending_object_deletions WHERE object_key=$1 AND available_at<=now() FOR UPDATE SKIP LOCKED", [key]);
      if (!claim.rowCount) { await client.query("COMMIT"); continue; }
      const referenced = await client.query<{ referenced: boolean }>(`SELECT
        EXISTS(SELECT 1 FROM raw_provider_events WHERE raw_object_key=$1 OR verification->>'objectKey'=$1)
        OR EXISTS(SELECT 1 FROM inbound_messages WHERE raw_mime_object_key=$1)
        OR EXISTS(SELECT 1 FROM inbound_attachments WHERE object_key=$1 AND content_purged_at IS NULL)
        OR EXISTS(SELECT 1 FROM outbound_files WHERE object_key=$1 AND content_purged_at IS NULL)
        OR EXISTS(SELECT 1 FROM messages WHERE content_purged_at IS NULL AND attachment_snapshot @> jsonb_build_array(jsonb_build_object('objectKey',$1::text))) AS referenced`, [key]);
      if (!referenced.rows[0].referenced) await (store ?? objectStore()).delete(key);
      await client.query("DELETE FROM pending_object_deletions WHERE object_key=$1", [key]);
      await client.query("COMMIT");
      result.applied++;
    } catch (error) {
      await client.query("ROLLBACK");
      result.failed++;
      const message = error instanceof Error ? error.message : "Object deletion failed";
      await client.query(`UPDATE pending_object_deletions SET attempt_count=attempt_count+1,last_error=$2,
        available_at=GREATEST(available_at,now()+LEAST(3600,30*power(2,LEAST(attempt_count,7)))*interval '1 second') WHERE object_key=$1`, [key, message.slice(0, 2000)]);
      console.error("Orphan object cleanup failed; retained for retry", key, message);
    }
  }
  return result;
}
