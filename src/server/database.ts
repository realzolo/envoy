import { Pool, type PoolClient, type QueryResultRow } from "pg";

const globalDatabase = globalThis as typeof globalThis & { __envoyPool?: Pool };

export function getDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production");
  }
  return value ?? "postgresql://envoy:envoy@localhost:5432/envoy";
}

export function db() {
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
  return db().query<T>(text, values);
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function databaseHealth() {
  const result = await query<{ now: Date }>("SELECT now()");
  return result.rows[0].now;
}
