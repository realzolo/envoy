import type { PoolClient } from "pg";
import { db, query, transaction } from "@/server/database";

export type RateLimitRequest = { scope: string; key: string; limit: number; windowSeconds?: number };

async function consume(client: Pick<PoolClient, "query">, request: RateLimitRequest) {
  const seconds = Math.max(1, Math.floor(request.windowSeconds ?? 60));
  const limit = Math.max(0, Math.floor(request.limit));
  const result = await client.query<{ count: string; reset_at: Date }>(
    `WITH rate_window AS (
       SELECT to_timestamp(floor(extract(epoch FROM statement_timestamp()) / $3) * $3) AS starts
     )
     INSERT INTO rate_limit_counters(scope,key,window_start,count,expires_at)
     SELECT $1,$2,starts,1,starts+($3+10)*interval '1 second' FROM rate_window WHERE $4 > 0
     ON CONFLICT(scope,key,window_start) DO UPDATE SET count=rate_limit_counters.count+1
       WHERE rate_limit_counters.count < $4
     RETURNING count,window_start+$3*interval '1 second' AS reset_at`,
    [request.scope, request.key, seconds, limit],
  );
  const row = result.rows[0];
  if (row) return { allowed: true, remaining: Math.max(0, limit - Number(row.count)), limit, resetAt: row.reset_at };
  const reset = await client.query<{ reset_at: Date }>(
    "SELECT to_timestamp((floor(extract(epoch FROM statement_timestamp()) / $1)+1)*$1) AS reset_at", [seconds],
  );
  return { allowed: false, remaining: 0, limit, resetAt: reset.rows[0].reset_at };
}

export async function enforceRateLimit(serviceId: string, limit: number) {
  return consume(db(), { scope: "service", key: serviceId, limit });
}

export async function enforceScopedRateLimit(scope: string, id: string, limit: number, windowSeconds = 60) {
  return (await consume(db(), { scope, key: id, limit, windowSeconds })).allowed;
}

// Called inside the business transaction: a rejected identity/provider pair consumes neither budget.
export async function reserveRateLimits(client: PoolClient, requests: RateLimitRequest[]) {
  await client.query("SAVEPOINT rate_limit_reservation");
  try {
    for (const request of [...requests].sort((a, b) => `${a.scope}:${a.key}`.localeCompare(`${b.scope}:${b.key}`))) {
      if (!(await consume(client, request)).allowed) {
        await client.query("ROLLBACK TO SAVEPOINT rate_limit_reservation");
        await client.query("RELEASE SAVEPOINT rate_limit_reservation");
        return false;
      }
    }
    await client.query("RELEASE SAVEPOINT rate_limit_reservation");
    return true;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT rate_limit_reservation");
    await client.query("RELEASE SAVEPOINT rate_limit_reservation");
    throw error;
  }
}

export async function reserveScopedRateLimits(requests: RateLimitRequest[]) {
  return transaction(client => reserveRateLimits(client, requests));
}

export async function writeWorkerHeartbeat(workerId: string) {
  await query(`INSERT INTO worker_heartbeats(worker_id,last_seen_at) VALUES ($1,now())
    ON CONFLICT(worker_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at`, [workerId]);
}

export async function removeWorkerHeartbeat(workerId: string) {
  await query("DELETE FROM worker_heartbeats WHERE worker_id=$1", [workerId]);
}

export async function workerHeartbeatAlive() {
  const result = await query<{ alive: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM worker_heartbeats WHERE last_seen_at > now()-interval '45 seconds') AS alive",
  );
  return result.rows[0].alive;
}

export async function cleanupRuntimeStore(limit = 1_000) {
  await query(`DELETE FROM rate_limit_counters WHERE ctid IN (
    SELECT ctid FROM rate_limit_counters WHERE expires_at < now() LIMIT $1)`, [limit]);
  await query("DELETE FROM worker_heartbeats WHERE last_seen_at < now()-interval '1 day'");
}
