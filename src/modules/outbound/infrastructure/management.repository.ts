import type { PoolClient } from "pg";
import type { ManagementRepository } from "../application/ports";

export function createManagementRepository(client: Pick<PoolClient, "query">): ManagementRepository {
    return {
        recordAudit(input) {
            return client.query<Record<string, unknown>>(
                "INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,$2,$3,$4,$5)",
                [input.actor, input.action, input.resourceType, input.resourceId, input.details],
            );
        },
        findTestService(input) {
            return client.query<{ service_id: string; service_name: string }>(
                "SELECT id AS service_id,name AS service_name FROM services WHERE id=$1 AND status='active'",
                [input.serviceId],
            );
        },
    };
}
