import { createId } from "@/server/ids";
import { query } from "@/server/database";

export async function recordRequest(input: {
  requestId?: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  actor?: string | null;
  details?: Record<string, unknown>;
}) {
  await query(
    `INSERT INTO request_logs(request_id, method, path, status_code, duration_ms, actor, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [input.requestId ?? createId("req"), input.method, input.path, input.statusCode,
      input.durationMs, input.actor ?? null, input.details ?? {}],
  );
}

