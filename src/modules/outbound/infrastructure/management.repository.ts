import type { PoolClient } from "pg";
import type { ManagementRepository } from "../application/ports";
import type { SimulationRow } from "../contracts";
export function createManagementRepository(client: Pick<PoolClient, "query">): ManagementRepository {
    return {
        recordAudit(input: {
            actor: string;
            action: string;
            resourceType: string;
            resourceId: string | null;
            details: Record<string, unknown>;
        }) { return client.query<Record<string, unknown>>("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,$2,$3,$4,$5)", [input.actor, input.action, input.resourceType, input.resourceId, input.details]); },
        findServices(input) { return client.query<{id:string}>("SELECT id FROM services WHERE id=ANY($1::text[]) FOR SHARE", [input.serviceIds]); },
        async replacePolicyServices(input) {
            await client.query("DELETE FROM routing_policy_services WHERE policy_id=$1", [input.policyId]);
            if (input.serviceIds.length) await client.query("INSERT INTO routing_policy_services(policy_id,service_id) SELECT $1,unnest($2::text[])", [input.policyId,input.serviceIds]);
        },
        findDomain(input: {
            domainId: string;
        }) { return client.query<{
            id: string;
            status: string;
        }>("SELECT id,status FROM sending_domains WHERE id=$1", [input.domainId]); },
        listTargetIdentities(input: {
            identityIds: string[];
        }) {
            return client.query<{
                id: string;
                sending_domain_id: string;
                provider_account_id: string;
                status: string;
                account_status: string;
            }>(`SELECT pi.id,pi.sending_domain_id,pi.provider_account_id,pi.status,pa.status AS account_status
      FROM provider_identities pi JOIN provider_accounts pa ON pa.id=pi.provider_account_id
      WHERE pi.id=ANY($1::text[])`, [input.identityIds]);
        },
        lockPolicy(input: {
            policyId: string;
        }) { return client.query<Record<string, unknown>>("SELECT id FROM routing_policies WHERE id=$1 FOR UPDATE", [input.policyId]); },
        deleteUnselectedTargets(input: {
            policyId: string;
            identityIds: string[];
        }) { return client.query<Record<string, unknown>>("DELETE FROM routing_targets WHERE policy_id=$1 AND NOT(provider_identity_id=ANY($2::text[]))", [input.policyId, input.identityIds]); },
        updatePolicy(input: {
            id: string;
            name: string;
            serviceScope: "all" | "selected";
            domainId: string;
            category: string | null;
            priority: number;
        }) { return client.query<Record<string, unknown>>("UPDATE routing_policies SET name=$2,service_scope=$3,sending_domain_id=$4,message_category=$5,priority=$6,updated_at=now() WHERE id=$1", [input.id, input.name, input.serviceScope, input.domainId, input.category, input.priority]); },
        insertPolicy(input: {
            id: string;
            name: string;
            serviceScope: "all" | "selected";
            domainId: string;
            category: string | null;
            priority: number;
        }) { return client.query<Record<string, unknown>>("INSERT INTO routing_policies(id,name,service_scope,sending_domain_id,message_category,priority) VALUES ($1,$2,$3,$4,$5,$6)", [input.id, input.name, input.serviceScope, input.domainId, input.category, input.priority]); },
        saveTarget(input: {
            id: string;
            policyId: string;
            accountId: string;
            identityId: string;
            priority: number;
            weight: number;
            rateLimit: number;
        }) { return client.query<Record<string, unknown>>("INSERT INTO routing_targets(id,policy_id,provider_account_id,provider_identity_id,priority,weight,rate_limit_per_minute) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(policy_id,provider_identity_id) DO UPDATE SET priority=EXCLUDED.priority,weight=EXCLUDED.weight,rate_limit_per_minute=EXCLUDED.rate_limit_per_minute,updated_at=now()", [input.id, input.policyId, input.accountId, input.identityId, input.priority, input.weight, input.rateLimit]); },
        recordPolicyAudit(input: {
            actor: string;
            policyId: string;
            details: {
                services: {mode:"all"|"selected";serviceIds:string[]};
                domainId: string;
                category: string | null;
                priority: number;
                targetCount: number;
            };
            action: "routing_policy.update" | "routing_policy.create";
        }) { return client.query<Record<string, unknown>>("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,$4,'routing_policy',$2,$3)", [input.actor, input.policyId, input.details, input.action]); },
        setPolicyStatus(input: {
            policyId: string;
            status: "active" | "disabled";
        }) { return client.query<Record<string, unknown>>("UPDATE routing_policies SET status=$2,updated_at=now() WHERE id=$1", [input.policyId, input.status]); },
        listSimulationCandidates(input: {
            domainId: string;
            serviceId: string | null;
            category: string | null;
        }) {
            return client.query<SimulationRow>(`SELECT rp.id AS policy_id,rp.name AS policy_name,rp.priority AS policy_priority,rt.id AS target_id,rt.priority,rt.weight,rt.status,rt.circuit_open_until,
    pa.id AS account_id,pa.name AS account,pa.type,pa.status AS account_status,pa.health,pa.quota,pi.id AS identity_id,pi.status AS identity_status,sd.domain,sd.status AS domain_status,
    usage.monthly_usage::text,usage.daily_usage::text
    FROM routing_policies rp JOIN routing_targets rt ON rt.policy_id=rp.id JOIN provider_accounts pa ON pa.id=rt.provider_account_id
    JOIN provider_identities pi ON pi.id=rt.provider_identity_id AND pi.provider_account_id=pa.id JOIN sending_domains sd ON sd.id=pi.sending_domain_id
    CROSS JOIN LATERAL(SELECT count(*)FILTER(WHERE da.started_at>=date_trunc('month',now())AND da.status IN('submitting','accepted','reconciled','unknown','reconciling'))monthly_usage,count(*)FILTER(WHERE da.started_at>=date_trunc('day',now())AND da.status IN('submitting','accepted','reconciled','unknown','reconciling'))daily_usage FROM submission_attempts da JOIN submission_deliveries sm ON sm.submission_id=da.submission_id WHERE da.provider_account_id=pa.id)usage
    WHERE rp.status='active' AND rp.sending_domain_id=$1 AND pi.sending_domain_id=$1 AND (rp.service_scope='all' OR EXISTS(SELECT 1 FROM routing_policy_services rs WHERE rs.policy_id=rp.id AND rs.service_id=$2)) AND (rp.message_category IS NULL OR rp.message_category=$3) ORDER BY rp.priority,rt.priority,rt.id`, [input.domainId, input.serviceId, input.category]);
        },
        findTestService(input: {
            serviceId: string;
        }) {
            return client.query<{
                service_id: string;
                service_name: string;
            }>(`SELECT s.id AS service_id,s.name AS service_name
      FROM services s
      WHERE s.id=$1 AND s.status='active'`, [input.serviceId]);
        },
    };
}
