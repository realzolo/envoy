import IORedis from "ioredis";

const globalRedis = globalThis as typeof globalThis & { __envoyRedis?: IORedis };
const WORKER_HEARTBEAT_KEY = "envoy:worker:heartbeat";
const WORKER_HEARTBEAT_TTL_SECONDS = 45;

export function getRedisUrl() {
  const value = process.env.REDIS_URL;
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error("REDIS_URL is required in production");
  }
  return value ?? "redis://localhost:6379";
}

export function redis() {
  globalRedis.__envoyRedis ??= new IORedis(getRedisUrl(), {
    enableReadyCheck: true,
    maxRetriesPerRequest: 2,
  });
  return globalRedis.__envoyRedis;
}

export function createWorkerRedis() {
  return new IORedis(getRedisUrl(), { maxRetriesPerRequest: null });
}

export async function enforceRateLimit(serviceId: string, limit: number) {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `envoy:rate:${serviceId}:${minute}`;
  const count = await redis().incr(key);
  if (count === 1) await redis().expire(key, 70);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), limit };
}

export async function enforceScopedRateLimit(scope: string, id: string, limit: number, windowSeconds = 60) {
  const seconds = Math.max(1, Math.floor(windowSeconds));
  const window = Math.floor(Date.now() / (seconds * 1_000));
  const key = `envoy:rate:${scope}:${id}:${window}`;
  const count = await redis().incr(key);
  if (count === 1) await redis().expire(key, seconds + 10);
  return count <= limit;
}

export async function redisHealth() {
  return redis().ping();
}

export async function writeWorkerHeartbeat(connection: Pick<IORedis, "set">, workerId: string) {
  await connection.set(WORKER_HEARTBEAT_KEY, JSON.stringify({ workerId, at: new Date().toISOString() }), "EX", WORKER_HEARTBEAT_TTL_SECONDS);
}

export async function workerHeartbeatAlive() {
  try {
    return Boolean(await redis().get(WORKER_HEARTBEAT_KEY));
  } catch {
    return false;
  }
}
