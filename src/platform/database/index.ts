import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { TransactionContext, UnitOfWork } from "../transactions";
import * as schema from "./schema";

const globalDatabase = globalThis as typeof globalThis & { __envoyPool?: Pool };

export function getDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production");
  }
  return value ?? "postgresql://envoy:envoy@localhost:5432/envoy";
}

export function pool() {
  const max=Number(process.env.DATABASE_POOL_SIZE ?? 10);
  if (!Number.isInteger(max) || max<1 || max>100) throw new Error("DATABASE_POOL_SIZE must be between 1 and 100");
  globalDatabase.__envoyPool ??= new Pool({
    connectionString: getDatabaseUrl(),
    max,
    options: "-c timezone=UTC",
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  return globalDatabase.__envoyPool;
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  return pool().query<T>(text, values);
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure after a broken connection. */ }
    throw error;
  } finally {
    const context = contexts.get(client);
    if (context) clients.delete(context);
    contexts.delete(client);
    client.release();
  }
}

export async function databaseHealth() {
  const result = await query<{ now: Date }>("SELECT now()");
  return result.rows[0].now;
}

/** Infrastructure compatibility alias; application code must use semantic repositories. */
export const db = pool;

export function database(client: Pool | PoolClient = pool()) {
  return drizzle(client, { schema });
}

const clients = new WeakMap<TransactionContext, PoolClient>();
const contexts = new WeakMap<PoolClient, TransactionContext>();

export function transactionContext(client: PoolClient): TransactionContext {
  let context = contexts.get(client);
  if (!context) {
    context = Object.freeze({ transactionId: Symbol("database transaction") });
    contexts.set(client, context);
    clients.set(context, client);
  }
  return context;
}

export function transactionClient(context: TransactionContext): PoolClient {
  const client = clients.get(context);
  if (!client) throw new Error("Unknown or expired transaction context");
  return client;
}

export function createUnitOfWork<Repositories>(factory: (client: PoolClient) => Repositories): UnitOfWork<Repositories> {
  return { run: work => transaction(client => work(factory(client))) };
}
