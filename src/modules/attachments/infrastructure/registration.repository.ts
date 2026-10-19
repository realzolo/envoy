import type { PoolClient } from "pg";

import type { RegistrationRepository } from "../application/ports";


export function createRegistrationRepository(client: Pick<PoolClient,"query">): RegistrationRepository {
return {
  ensureScanScope(input: { scope: string }) { return client.query<Record<string,unknown>>("INSERT INTO attachment_scan_scopes(scope) VALUES($1) ON CONFLICT DO NOTHING", [input.scope]); },
  registerSafety(input: { id: string; kind: "outbound" | "inbound"; serviceId: string | null; scope: string; sha256: string }) { return client.query<Record<string,unknown>>(`INSERT INTO attachment_safety(resource_id,kind,service_id,scope,expected_sha256) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [input.id, input.kind, input.serviceId, input.scope, input.sha256]); },
};
}
