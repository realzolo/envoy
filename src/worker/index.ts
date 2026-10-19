import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());
// Load dependency assembly after .env, before any queues, credentials or database clients exist.
void import("@/bootstrap/worker").then(({ runWorker }) => runWorker()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
