import { loadEnvConfig } from "@next/env";
import { pool } from "../src/platform/database";
import { initializeV1 } from "../src/platform/database/initialization";

loadEnvConfig(process.cwd());

async function main() {
  const client = await pool().connect();
  try {
    const status = await initializeV1(client);
    console.log(`Envoy V1 ${status}; official BullMQ PostgreSQL schema is compatible`);
  } finally {
    client.release();
    await pool().end();
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
