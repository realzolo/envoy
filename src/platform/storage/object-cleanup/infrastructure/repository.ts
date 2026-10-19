import { pool } from "@/platform/database";
import type { Pool, PoolClient } from "pg";
import type { ObjectCleanupRepository } from "../application/service";
export function objectCleanupRepository(client: Pick<Pool | PoolClient, "query"> = pool()): ObjectCleanupRepository {
    return {
        async register(key) {
            await client.query(`INSERT INTO pending_object_deletions(object_key,available_at) VALUES ($1,now()+interval '10 minutes')
        ON CONFLICT(object_key) DO UPDATE SET available_at=EXCLUDED.available_at`, [key]);
        },
        async complete(keys) {
            const result = await client.query("DELETE FROM pending_object_deletions WHERE object_key=ANY($1::text[]) RETURNING object_key", [keys]);
            return result.rowCount ?? 0;
        },
        async listCandidates(limit) {
            return (await client.query<{
                object_key: string;
            }>("SELECT object_key FROM pending_object_deletions WHERE available_at<=now() ORDER BY available_at,object_key LIMIT $1", [limit])).rows.map(row => row.object_key);
        },
        async claim(key) {
            return Boolean((await client.query("SELECT object_key FROM pending_object_deletions WHERE object_key=$1 AND available_at<=now() FOR UPDATE SKIP LOCKED", [key])).rowCount);
        },
        async isReferenced(key) {
            return (await client.query<{
                referenced: boolean;
            }>(`SELECT
        EXISTS(SELECT 1 FROM raw_provider_events WHERE raw_object_key=$1 OR verification->>'objectKey'=$1)
        OR EXISTS(SELECT 1 FROM inbound_messages WHERE raw_mime_object_key=$1)
        OR EXISTS(SELECT 1 FROM inbound_attachments WHERE object_key=$1 AND content_purged_at IS NULL)
        OR EXISTS(SELECT 1 FROM outbound_files WHERE object_key=$1 AND content_purged_at IS NULL)
        OR EXISTS(SELECT 1 FROM messages WHERE content_purged_at IS NULL AND attachment_snapshot @> jsonb_build_array(jsonb_build_object('objectKey',$1::text))) AS referenced`, [key])).rows[0].referenced;
        },
        async removeClaim(key) { await client.query("DELETE FROM pending_object_deletions WHERE object_key=$1", [key]); },
        async recordFailure(key, message) {
            await client.query(`UPDATE pending_object_deletions SET attempt_count=attempt_count+1,last_error=$2,
        available_at=GREATEST(available_at,now()+LEAST(3600,30*power(2,LEAST(attempt_count,7)))*interval '1 second') WHERE object_key=$1`, [key, message]);
        },
    };
}
