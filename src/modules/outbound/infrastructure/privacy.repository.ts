import { transaction } from "@/platform/database";
import { cleanupOrphanObjects } from "@/platform/storage/object-cleanup/public";
/** Mandatory privacy cleanup independent of optional normal-message retention. Receipts/callbacks remain live. */
export async function purgeExpiredSensitiveContent(limit = 200) {
    const messages = await transaction(async (client) => {
        const rows = await client.query<{
            id: string;
        }>(`SELECT id FROM messages WHERE sensitive_content IS NOT NULL
      AND send_before<=clock_timestamp() ORDER BY send_before,id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
        for (const row of rows.rows)
            await client.query(`UPDATE messages SET sensitive_content=NULL,
      sensitive_content_purged_at=clock_timestamp() WHERE id=$1`, [row.id]);
        return rows.rowCount ?? 0;
    });
    const receipts = await transaction(async (client) => {
        const raw = await client.query<{
            id: string;
            raw_object_key: string | null;
            receipt_object_key: string | null;
        }>(`SELECT id,raw_object_key,verification->>'objectKey' AS receipt_object_key
      FROM raw_provider_events WHERE payload_expires_at<=clock_timestamp() AND raw_payload_purged_at IS NULL AND normalized_events IS NOT NULL
      ORDER BY payload_expires_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
        for (const item of raw.rows) {
            for (const key of [item.raw_object_key, item.receipt_object_key])
                if (key)
                    await client.query("INSERT INTO pending_object_deletions(object_key,available_at) VALUES($1,clock_timestamp()) ON CONFLICT(object_key) DO UPDATE SET available_at=EXCLUDED.available_at", [key]);
            await client.query(`UPDATE raw_provider_events SET raw_body=NULL,raw_object_key=NULL,verification='{}',headers='{}',
        raw_payload_purged_at=clock_timestamp() WHERE id=$1`, [item.id]);
        }
        return raw.rowCount ?? 0;
    });
    await cleanupOrphanObjects(true, limit);
    return messages + receipts;
}
