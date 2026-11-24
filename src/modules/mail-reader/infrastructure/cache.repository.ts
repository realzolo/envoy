import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TransactionContext } from "@/platform/transactions";
import { query, transaction, transactionClient } from "@/platform/database";
import { type Envelope, openSecret, sealSecret } from "@/platform/crypto/envelope";
import type { ReaderCacheEntry, ReaderCacheIdentity, ReaderCacheImage, ReaderCacheJob } from "../cache-contracts";

export const MAX_READER_DOCUMENT_BYTES = 100_000_000;
const MAX_RESOURCE_ATTEMPTS = 3;
const RESOURCE_LEASE_SECONDS = 45;
const RETRY_DELAY_SECONDS = 30;
const DEFAULT_PREPARATION_BATCH_SIZE = 3;
const MAX_READER_IMAGE_BYTES = 20_000_000;
const MAX_RETRY_RESOURCE_COUNT = 256;
const identityWhere = "source_kind=$1 AND source_id=$2 AND source_revision=$3 AND resource_id=$4";
const params = (key: ReaderCacheIdentity) => [key.kind, key.id, key.revision, key.resourceId];
const aad = (key: ReaderCacheIdentity) => `mail-reader:${key.kind}:${key.id}:${key.revision}:${key.resourceId}`;
const retained = `((source_kind='INBOUND' AND EXISTS(SELECT 1 FROM inbound_messages i WHERE i.id=source_id AND i.status='ready' AND i.content_purged_at IS NULL)) OR
  (source_kind='OUTBOUND' AND EXISTS(SELECT 1 FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.id=source_id AND m.content_purged_at IS NULL AND m.content_policy='normal')))`;

/** Content cache and durable resource work share one identity. Authorization is checked by the application on every use. */
export const readerCache = {
  async get(key: ReaderCacheIdentity, includeBytes = true): Promise<ReaderCacheEntry | null> {
    const row = (await query<{
      state: ReaderCacheEntry["state"];
      reason_code: string | null;
      content_type: string | null;
      size_bytes: string | null;
      sha256: string | null;
      cached_content: Envelope | null;
      available_at: Date;
      updated_at: Date
    }>(
      `SELECT state,reason_code,content_type,size_bytes::text,sha256,${includeBytes ? "cached_content" : "NULL AS cached_content"},available_at,updated_at FROM mail_reader_resources WHERE ${identityWhere} AND ${retained}`, params(key))).rows[0];
    if (!row) return null;
    return {
      state: row.state,
      reasonCode: row.reason_code,
      contentType: row.content_type,
      size: row.size_bytes === null ? null : Number(row.size_bytes),
      sha256: row.sha256,
      bytes: includeBytes && row.state === "READY" && row.cached_content ? Buffer.from(openSecret<{
        base64: string
      }>(row.cached_content, aad(key), 1).base64, "base64") : undefined,
      nextAttemptAt: row.available_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    };
  },
  async enqueue(key: ReaderCacheIdentity, serviceId: string | null, context?: TransactionContext) {
    const work = async (client: PoolClient) => {
      const owner = key.kind === "INBOUND"
        ? await client.query("SELECT id FROM inbound_messages WHERE id=$1 AND status='ready' AND content_purged_at IS NULL FOR SHARE", [key.id])
        : await client.query("SELECT m.id FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE d.id=$1 AND m.content_purged_at IS NULL AND m.content_policy='normal' FOR SHARE OF m", [key.id]);
      if (!owner.rowCount) return;
      if (key.kind === "OUTBOUND" && !(await client.query("SELECT id FROM deliveries WHERE id=$1 FOR SHARE", [key.id])).rowCount) return;
      await client.query(`INSERT INTO mail_reader_resources(source_kind,source_id,source_revision,resource_id,service_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [...params(key), serviceId]);
    };
    if (context) await work(transactionClient(context));
    else await transaction(work);
  },
  /** Cancel only the failed authorization scope's unfinished demand; immutable cached content is unaffected. */
  async cancelUnauthorizedDemand(job: ReaderCacheJob) {
    await query(`DELETE FROM mail_reader_resources WHERE ${identityWhere} AND service_id IS NOT DISTINCT FROM $5
      AND cached_content IS NULL AND updated_at=$6::timestamptz`, [...params(job), job.serviceId, job.updatedAt]);
  },
  /** A transient source read can fail before resource claim. It consumes its own bounded preparation attempt. */
  async deferPreparationDemand(job: ReaderCacheJob) {
    await query(`UPDATE mail_reader_resources SET attempt_count=attempt_count+1,
      state=CASE WHEN attempt_count+1<$6 THEN 'RETRY_WAIT' ELSE 'UNAVAILABLE' END,
      reason_code=CASE WHEN attempt_count+1<$6 THEN 'READING_SOURCE_PENDING' ELSE 'RETRY_EXHAUSTED' END,
      available_at=clock_timestamp()+make_interval(secs=>$7*(attempt_count+1)),updated_at=clock_timestamp()
      WHERE ${identityWhere} AND service_id IS NOT DISTINCT FROM $5 AND cached_content IS NULL
      AND state IN ('PENDING','RETRY_WAIT') AND available_at<=clock_timestamp() AND attempt_count<$6 AND updated_at=$8::timestamptz`,
      [...params(job), job.serviceId, MAX_RESOURCE_ATTEMPTS, RETRY_DELAY_SECONDS, job.updatedAt]);
  },
  async claim(key: ReaderCacheIdentity): Promise<{ token: string; serviceId: string | null } | null> {
    const token = randomUUID();
    const row = (await query<{ service_id: string | null }>(`UPDATE mail_reader_resources SET state='RUNNING',lease_token=$5,
      lease_expires_at=clock_timestamp()+make_interval(secs=>$6),attempt_count=attempt_count+1,updated_at=clock_timestamp()
      WHERE ${identityWhere} AND ${retained} AND attempt_count<$7 AND available_at<=clock_timestamp()
      AND (state IN ('PENDING','RETRY_WAIT') OR (state='RUNNING' AND lease_expires_at<=clock_timestamp())) RETURNING service_id`,
      [...params(key), token, RESOURCE_LEASE_SECONDS, MAX_RESOURCE_ATTEMPTS])).rows[0];
    return row ? { token, serviceId: row.service_id } : null;
  },
  async store(key: ReaderCacheIdentity, token: string, image: ReaderCacheImage) {
    if (!image.bytes.byteLength || image.bytes.byteLength > MAX_READER_IMAGE_BYTES) return false;
    return transaction(async client => {
      // Parent SHARE serializes publication with erasure; the parent lock is always acquired before cache locks.
      const owner = key.kind === "INBOUND"
        ? await client.query("SELECT id FROM inbound_messages WHERE id=$1 AND content_purged_at IS NULL AND status='ready' FOR SHARE", [key.id])
        : await client.query("SELECT m.id FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE d.id=$1 AND m.content_purged_at IS NULL AND m.content_policy='normal' FOR SHARE OF m", [key.id]);
      if (!owner.rowCount) return false;
      if (key.kind === "OUTBOUND" && !(await client.query("SELECT id FROM deliveries WHERE id=$1 FOR SHARE", [key.id])).rowCount) return false;
      // Serialize the document budget across resource publications.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${key.kind}:${key.id}:${key.revision}`]);
      const result = await client.query(`UPDATE mail_reader_resources SET state='READY',reason_code=NULL,cached_content=$6,content_type=$7,size_bytes=$8,sha256=$9,
        lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE ${identityWhere} AND state='RUNNING' AND lease_token=$5 AND lease_expires_at>clock_timestamp()
        AND $8::bigint+COALESCE((SELECT sum(size_bytes) FROM mail_reader_resources other WHERE other.source_kind=$1 AND other.source_id=$2 AND other.source_revision=$3 AND other.resource_id<>$4 AND other.state='READY'),0)<=$10 RETURNING resource_id`,
        [...params(key), token, sealSecret({ base64: Buffer.from(image.bytes).toString("base64") }, aad(key), 1), image.contentType, image.bytes.byteLength, image.sha256, MAX_READER_DOCUMENT_BYTES]);
      return !!result.rowCount;
    });
  },
  async fail(key: ReaderCacheIdentity, token: string, reasonCode: string, retryable: boolean) {
    await query(`UPDATE mail_reader_resources SET state=CASE WHEN $7 AND attempt_count<$8 THEN 'RETRY_WAIT' ELSE 'UNAVAILABLE' END,
      reason_code=$6,available_at=clock_timestamp()+make_interval(secs=>$9*attempt_count),lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE ${identityWhere} AND lease_token=$5`, [...params(key), token, reasonCode, retryable, MAX_RESOURCE_ATTEMPTS, RETRY_DELAY_SECONDS]);
  },
  async retryFailed(target: Pick<ReaderCacheIdentity, "kind" | "id" | "revision">, serviceId: string | null, operationId: string): Promise<number> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(operationId)) throw new Error("Invalid reader retry operation");
    return transaction(async client => {
      const owner = target.kind === "INBOUND"
        ? await client.query("SELECT id FROM inbound_messages WHERE id=$1 AND status='ready' AND content_purged_at IS NULL FOR SHARE", [target.id])
        : await client.query("SELECT m.id FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE d.id=$1 AND m.content_purged_at IS NULL AND m.content_policy='normal' FOR SHARE OF m", [target.id]);
      if (!owner.rowCount) return 0;
      if (target.kind === "OUTBOUND" && !(await client.query("SELECT id FROM deliveries WHERE id=$1 FOR SHARE", [target.id])).rowCount) return 0;
      // The operation lock also rejects operation reuse across different document or authorization scopes.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`mail-reader-retry:${operationId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${target.kind}:${target.id}:${target.revision}`]);
      const prior = (await client.query<{
        details: { kind: string; id: string; revision: string; serviceId: string | null }
      }>(
        "SELECT details FROM audit_logs WHERE action='mail_reader.retry_requested' AND resource_id=$1 LIMIT 1", [operationId])).rows[0];
      if (prior) {
        if (prior.details.kind !== target.kind || prior.details.id !== target.id || prior.details.revision !== target.revision || prior.details.serviceId !== serviceId)
          throw new Error("Reader retry operation scope changed");
        return 0;
      }
      const failed = (await client.query<{
        resource_id: string;
        attempt_count: number;
        reason_code: string | null;
        service_id: string | null
      }>(
        `SELECT resource_id,attempt_count,reason_code,service_id FROM mail_reader_resources WHERE source_kind=$1 AND source_id=$2 AND source_revision=$3
          AND state='UNAVAILABLE' AND cached_content IS NULL ORDER BY resource_id LIMIT $4 FOR UPDATE`,
        [target.kind, target.id, target.revision, MAX_RETRY_RESOURCE_COUNT])).rows;
      await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES($1,'mail_reader.retry_requested','mail_reader',$2,$3)",
        [serviceId ?? "admin", operationId, {
          ...target,
          serviceId,
          resources: failed.map(row => ({
            resourceId: row.resource_id,
            attemptCount: row.attempt_count,
            reasonCode: row.reason_code,
            priorServiceId: row.service_id
          }))
        }]);
      if (!failed.length) return 0;
      const result = await client.query(`UPDATE mail_reader_resources SET state='PENDING',attempt_count=0,reason_code=NULL,
        available_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),service_id=$5
        WHERE source_kind=$1 AND source_id=$2 AND source_revision=$3 AND resource_id=ANY($4::text[]) AND state='UNAVAILABLE'`,
        [target.kind, target.id, target.revision, failed.map(row => row.resource_id), serviceId]);
      return result.rowCount ?? 0;
    });
  },
  async pending(limit = DEFAULT_PREPARATION_BATCH_SIZE): Promise<ReaderCacheJob[]> {
    await query(`UPDATE mail_reader_resources SET state='UNAVAILABLE',reason_code='RETRY_EXHAUSTED',lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE state='RUNNING' AND lease_expires_at<=clock_timestamp() AND attempt_count>=$1`, [MAX_RESOURCE_ATTEMPTS]);
    const result = await query<{
      source_kind: ReaderCacheJob["kind"];
      source_id: string;
      source_revision: string;
      resource_id: string;
      service_id: string | null;
      updated_at: string
    }>(
      `SELECT source_kind,source_id,source_revision,resource_id,service_id,updated_at::text FROM mail_reader_resources WHERE ${retained} AND available_at<=clock_timestamp() AND attempt_count<$1
      AND (state IN ('PENDING','RETRY_WAIT') OR (state='RUNNING' AND lease_expires_at<=clock_timestamp())) ORDER BY available_at,created_at LIMIT $2`, [MAX_RESOURCE_ATTEMPTS, limit]);
    return result.rows.map(row => ({
      kind: row.source_kind,
      id: row.source_id,
      revision: row.source_revision,
      resourceId: row.resource_id,
      serviceId: row.service_id,
      updatedAt: row.updated_at
    }));
  },
};
