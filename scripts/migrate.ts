import { loadEnvConfig } from "@next/env";
import { pool } from "../src/platform/database";
import { initializeDatabase } from "../src/platform/database/initialization";

loadEnvConfig(process.cwd());

async function main() {
  const client = await pool().connect();
  try {
    const status = await initializeDatabase(client);
    console.log(`Envoy application schema ${status}; official BullMQ PostgreSQL schema is compatible`);
  } finally {
    client.release();
    await pool().end();
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
