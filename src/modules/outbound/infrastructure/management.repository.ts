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
        findService(input: {
            serviceId: string;
        }) { return client.query<{
            product_id: string;
        }>("SELECT product_id FROM services WHERE id=$1", [input.serviceId]); },
        findProduct(input: {
            productId: string;
        }) { return client.query<{
            id: string;
        }>("SELECT id FROM products WHERE id=$1", [input.productId]); },
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
        deleteTargets(input: {
            policyId: string;
        }) { return client.query<Record<string, unknown>>("DELETE FROM routing_targets WHERE policy_id=$1", [input.policyId]); },
        updatePolicy(input: {
            id: string;
            name: string;
            productId: string | null;
            serviceId: string | null;
            domainId: string;
            category: string | null;
            priority: number;
        }) { return client.query<Record<string, unknown>>("UPDATE routing_policies SET name=$2,product_id=$3,service_id=$4,sending_domain_id=$5,message_category=$6,priority=$7,updated_at=now() WHERE id=$1", [input.id, input.name, input.productId, input.serviceId, input.domainId, input.category, input.priority]); },
        insertPolicy(input: {
            id: string;
            name: string;
            productId: string | null;
            serviceId: string | null;
            domainId: string;
            category: string | null;
            priority: number;
        }) { return client.query<Record<string, unknown>>("INSERT INTO routing_policies(id,name,product_id,service_id,sending_domain_id,message_category,priority) VALUES ($1,$2,$3,$4,$5,$6,$7)", [input.id, input.name, input.productId, input.serviceId, input.domainId, input.category, input.priority]); },
        insertTarget(input: {
            id: string;
            policyId: string;
            accountId: string;
            identityId: string;
            priority: number;
            weight: number;
            rateLimit: number;
        }) { return client.query<Record<string, unknown>>("INSERT INTO routing_targets(id,policy_id,provider_account_id,provider_identity_id,priority,weight,rate_limit_per_minute) VALUES ($1,$2,$3,$4,$5,$6,$7)", [input.id, input.policyId, input.accountId, input.identityId, input.priority, input.weight, input.rateLimit]); },
        recordPolicyAudit(input: {
            actor: string;
            policyId: string;
            details: {
                productId: string | null;
                serviceId: string | null;
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
            productId: string | null;
            serviceId: string | null;
            category: string | null;
        }) {
            return client.query<SimulationRow>(`SELECT rp.id AS policy_id,rp.name AS policy_name,rp.priority AS policy_priority,rt.id AS target_id,rt.priority,rt.weight,rt.status,rt.circuit_open_until,
    pa.id AS account_id,pa.name AS account,pa.type,pa.status AS account_status,pa.health,pa.quota,pi.id AS identity_id,pi.status AS identity_status,sd.domain,sd.status AS domain_status,
    usage.monthly_usage::text,usage.daily_usage::text
    FROM routing_policies rp JOIN routing_targets rt ON rt.policy_id=rp.id JOIN provider_accounts pa ON pa.id=rt.provider_account_id
    JOIN provider_identities pi ON pi.id=rt.provider_identity_id AND pi.provider_account_id=pa.id JOIN sending_domains sd ON sd.id=pi.sending_domain_id
    CROSS JOIN LATERAL(SELECT count(*)FILTER(WHERE da.started_at>=date_trunc('month',now())AND da.status IN('submitting','accepted','reconciled','unknown','reconciling'))monthly_usage,count(*)FILTER(WHERE da.started_at>=date_trunc('day',now())AND da.status IN('submitting','accepted','reconciled','unknown','reconciling'))daily_usage FROM submission_attempts da JOIN submission_deliveries sm ON sm.submission_id=da.submission_id WHERE da.provider_account_id=pa.id)usage
    WHERE rp.status='active' AND rp.sending_domain_id=$1 AND pi.sending_domain_id=$1 AND (rp.product_id IS NULL OR rp.product_id=$2) AND (rp.service_id IS NULL OR rp.service_id=$3) AND (rp.message_category IS NULL OR rp.message_category=$4) ORDER BY rp.priority,rt.priority,rt.id`, [input.domainId, input.productId, input.serviceId, input.category]);
        },
        findTestService(input: {
            serviceId: string;
        }) {
            return client.query<{
                service_id: string;
                service_name: string;
                product_id: string;
                product_name: string;
            }>(`SELECT s.id AS service_id,s.name AS service_name,p.id AS product_id,p.name AS product_name
      FROM services s JOIN products p ON p.id=s.product_id
      WHERE s.id=$1 AND p.status='active'`, [input.serviceId]);
        },
    };
}
