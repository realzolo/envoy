import { inboundDomainAccess,outboundDomainAccess } from "./authorization";
import type { PoolClient } from "pg";
import { transaction } from "@/server/database";

export class ContentConflictError extends Error {
  constructor(public code: "CONTENT_BUSY" | "CONTENT_SHARED") { super(code); }
}

async function forgetObject(client: PoolClient, key: string | null) {
  if (key) await client.query(`INSERT INTO pending_object_deletions(object_key,available_at) VALUES($1,now())
    ON CONFLICT(object_key) DO UPDATE SET available_at=EXCLUDED.available_at`,[key]);
}

async function purgeUnsharedRaw(client:PoolClient,id:string) {
  await client.query("SELECT id FROM raw_provider_events WHERE id=$1 FOR UPDATE",[id]);
  const raw=(await client.query<{raw_object_key:string|null;receipt_object_key:string|null}>(`SELECT r.raw_object_key,r.verification->>'objectKey' AS receipt_object_key
    FROM raw_provider_events r WHERE r.id=$1 AND (r.processed_at IS NOT NULL OR r.terminated_at IS NOT NULL) AND r.content_purged_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM inbound_messages i WHERE i.raw_provider_event_id=r.id AND i.content_purged_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id JOIN messages m ON m.id=d.message_id WHERE de.raw_provider_event_id=r.id AND m.content_purged_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM submission_events se JOIN submissions sub ON sub.id=se.submission_id JOIN messages m ON m.id=sub.message_id WHERE se.raw_provider_event_id=r.id AND m.content_purged_at IS NULL)`,[id])).rows[0];
  if(!raw) return;
  await forgetObject(client,raw.raw_object_key);await forgetObject(client,raw.receipt_object_key);
  await client.query("UPDATE raw_provider_events SET normalized_events=NULL,raw_body=NULL,raw_object_key=NULL,headers='{}',verification='{}',content_purged_at=clock_timestamp() WHERE id=$1",[id]);
}

/** Tombstones and deletion intents commit atomically; storage failures cannot restore API access. */
export async function purgeContent(kind: "inbound" | "message" | "file", id: string, serviceId: string) {
  return transaction(async client => {
    const table = kind === "inbound" ? "inbound_messages" : kind === "message" ? "messages" : "outbound_files";
    const row = (await client.query<{ content_purged_at: Date | null; status?: string; attachment_snapshot?: { fileId: string }[]; raw_provider_event_id?: string; raw_mime_object_key?: string; object_key?: string }>(`SELECT * FROM ${table} WHERE id=$1 AND service_id=$2 AND ${kind==='inbound'?inboundDomainAccess(table):outboundDomainAccess(table)} FOR UPDATE`,[id,serviceId])).rows[0];
    if (!row) return null;
    if (row.content_purged_at) return { id,contentPurgedAt:row.content_purged_at.toISOString(),objectDeletion:"pending_or_complete" };
    if (kind === "file") {
      // Acceptance locks files FOR SHARE. A retained snapshot still needs the original bytes.
      const used = await client.query("SELECT id FROM messages WHERE content_purged_at IS NULL AND attachment_snapshot @> $1::jsonb LIMIT 1",[JSON.stringify([{ fileId:id }])]);
      if (used.rowCount) throw new ContentConflictError("CONTENT_SHARED");
      await forgetObject(client,row.object_key!);
      await client.query("UPDATE outbound_files SET file_name='',content_purged_at=clock_timestamp() WHERE id=$1",[id]);
    } else {
      if (kind === "message") {
        await client.query("SELECT id FROM submissions WHERE message_id=$1 ORDER BY id FOR UPDATE",[id]);
        await client.query("SELECT id FROM deliveries WHERE message_id=$1 ORDER BY id FOR UPDATE",[id]);
        const unsafe = await client.query(`SELECT 1 FROM deliveries WHERE message_id=$1 AND lifecycle_status NOT IN ('delivered','bounced','failed','canceled')
          UNION ALL SELECT 1 FROM submission_attempts a JOIN submissions s ON s.id=a.submission_id WHERE s.message_id=$1 AND a.status IN ('submitting','unknown','reconciling') LIMIT 1`,[id]);
        if (unsafe.rowCount) throw new ContentConflictError("CONTENT_BUSY");
      } else if (row.status === "scanning") throw new ContentConflictError("CONTENT_BUSY");
      const callbacks = (await client.query<{ id: string; status: string }>(`SELECT c.id,c.status FROM callback_deliveries c
        WHERE ${kind === "inbound" ? "c.inbound_message_id=$1" : `c.delivery_event_id IN (SELECT e.id FROM delivery_events e JOIN deliveries d ON d.id=e.delivery_id WHERE d.message_id=$1)
          OR c.submission_event_id IN (SELECT e.id FROM submission_events e JOIN submissions s ON s.id=e.submission_id WHERE s.message_id=$1)`}
        ORDER BY c.id FOR UPDATE`,[id])).rows;
      if (callbacks.some(c => c.status === "delivering")) throw new ContentConflictError("CONTENT_BUSY");
      await client.query(`UPDATE callback_deliveries SET payload='{}',payload_purged_at=clock_timestamp(),
        status=CASE WHEN status='delivered' THEN status ELSE 'terminated' END,
        terminated_at=CASE WHEN status='delivered' THEN terminated_at ELSE COALESCE(terminated_at,clock_timestamp()) END,updated_at=now()
        WHERE id=ANY($1::text[])`,[callbacks.map(c=>c.id)]);
      if (kind === "inbound") {
        const files = (await client.query<{ object_key: string }>("SELECT object_key FROM inbound_attachments WHERE inbound_message_id=$1 AND content_purged_at IS NULL FOR UPDATE",[id])).rows;
        for (const file of files) await forgetObject(client,file.object_key);
        await forgetObject(client,row.raw_mime_object_key ?? null);
        await client.query("UPDATE inbound_attachments SET file_name='',content_id=NULL,content_purged_at=clock_timestamp() WHERE inbound_message_id=$1 AND content_purged_at IS NULL",[id]);
        await client.query("UPDATE inbound_messages SET subject='',sanitized_html=NULL,text_body=NULL,raw_mime_object_key=NULL,content_purged_at=clock_timestamp() WHERE id=$1",[id]);
        // Raw ingress is shared administrative evidence. It can be erased only after all frozen copies are gone.
        if (row.raw_provider_event_id) await purgeUnsharedRaw(client,row.raw_provider_event_id);
      } else {
        await client.query(`UPDATE messages SET sensitive_content=NULL,sensitive_content_purged_at=COALESCE(sensitive_content_purged_at,clock_timestamp()),subject='',html_body=NULL,text_body='',headers='{}',metadata='{}',provider_tags='{}',
          attachment_snapshot='[]',content_purged_at=clock_timestamp() WHERE id=$1`,[id]);
        const rawIds=(await client.query<{id:string}>(`SELECT DISTINCT raw_provider_event_id AS id FROM (
          SELECT e.raw_provider_event_id FROM delivery_events e JOIN deliveries d ON d.id=e.delivery_id WHERE d.message_id=$1
          UNION ALL SELECT e.raw_provider_event_id FROM submission_events e JOIN submissions sub ON sub.id=e.submission_id WHERE sub.message_id=$1
        ) source WHERE raw_provider_event_id IS NOT NULL ORDER BY id`,[id])).rows;
        for(const raw of rawIds) await purgeUnsharedRaw(client,raw.id);
        // Files have their own service-owned lifecycle: remove only unshared files after message snapshots disappear.
        await client.query("SELECT id FROM outbound_files WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE",[(row.attachment_snapshot ?? []).map(file=>file.fileId)]);
        // Recheck references in a fresh snapshot after waiting for the file locks.
        for (const file of row.attachment_snapshot ?? []) {
          const owned = (await client.query<{ object_key: string }>(`SELECT f.object_key FROM outbound_files f WHERE f.id=$1 AND f.service_id=$2 AND f.content_purged_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.content_purged_at IS NULL AND m.attachment_snapshot @> $3::jsonb)`,[file.fileId,serviceId,JSON.stringify([{fileId:file.fileId}])])).rows[0];
          if (owned) { await forgetObject(client,owned.object_key); await client.query("UPDATE outbound_files SET file_name='',content_purged_at=clock_timestamp() WHERE id=$1",[file.fileId]); }
        }
      }
    }
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES($1,'content.purge',$2,$3,$4)",[`service:${serviceId}`,table,id,{ source:"service_request" }]);
    const result = (await client.query<{ content_purged_at: Date }>(`SELECT content_purged_at FROM ${table} WHERE id=$1`,[id])).rows[0];
    return { id,contentPurgedAt:result.content_purged_at.toISOString(),objectDeletion:"pending_or_complete" };
  });
}
