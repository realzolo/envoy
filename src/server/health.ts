import { databaseHealth } from "@/platform/database";
import { queueSchemaHealth } from "@/platform/queues";
import { outboxBacklog } from "@/platform/outbox/public";

export async function checkSystemHealth() {
  await Promise.all([databaseHealth(), queueSchemaHealth(), outboxBacklog()]);
}
