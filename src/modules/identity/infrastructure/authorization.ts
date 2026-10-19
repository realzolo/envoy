import { query } from "@/platform/database";
import type { PoolClient } from "pg";

/** SQL expressions passed here come from internal queries, never request input. */
export function domainPermission(serviceId: string, domainId: string, permission: "send" | "receive") {
  const direction = permission === "send" ? "b.outbound_provider_identity_id IS NOT NULL" : "b.receive_enabled AND d.inbound_provider_account_id IS NOT NULL";
  return `EXISTS(SELECT 1 FROM service_domain_bindings b
    JOIN sending_domains d ON d.id=b.sending_domain_id
    JOIN services s ON s.id=b.service_id
    WHERE b.service_id=${serviceId} AND b.sending_domain_id=${domainId}
      AND ${direction} AND d.status='active' AND s.status='active')`;
}

/** One row per Service and domain; the Service revision fences configuration edits. */
export function effectiveDomainBinding(serviceId: string, domainId: string) {
  return `SELECT 'active' AS status,
    (b.outbound_provider_identity_id IS NOT NULL) AS send_allowed,
    (b.receive_enabled AND d.inbound_provider_account_id IS NOT NULL) AS receive_allowed,
    s.configuration_revision AS revision
    FROM service_domain_bindings b
    JOIN sending_domains d ON d.id=b.sending_domain_id
    JOIN services s ON s.id=b.service_id
    WHERE b.service_id=${serviceId} AND b.sending_domain_id=${domainId}`;
}

/** These predicates use frozen transport ownership, never caller-supplied domain claims. */
export function outboundDomainAccess(alias: string) {
  return domainPermission(`${alias}.service_id`, `${alias}.sending_domain_id`, "send");
}
export function inboundDomainAccess(alias: string) {
  // A multi-domain resource is indivisible: fail closed if any private envelope domain was revoked.
  return `(cardinality(${alias}.envelope_recipients)>0 AND NOT EXISTS(
    SELECT 1 FROM unnest(${alias}.envelope_recipients) er WHERE NOT EXISTS(
      SELECT 1 FROM sending_domains d WHERE d.domain=split_part(er,'@',2)
        AND d.inbound_provider_account_id=${alias}.provider_account_id
        AND ${domainPermission(`${alias}.service_id`, "d.id", "receive")})))`;
}
export async function authorizedSendingDomain(serviceId: string, domain: string, client?: PoolClient) {
  const sql = `SELECT d.id FROM sending_domains d WHERE d.domain=$2 AND ${domainPermission("$1", "d.id", "send")}`;
  return (await (client?client.query<{id:string}>(sql,[serviceId,domain.toLowerCase()]):query<{id:string}>(sql,[serviceId,domain.toLowerCase()]))).rows[0]?.id ?? null;
}
export async function canAccessInbound(id:string, serviceId:string, client?:PoolClient) {
  const sql=`SELECT i.id FROM inbound_messages i WHERE i.id=$1 AND i.service_id=$2 AND ${inboundDomainAccess('i')}`;
  return Boolean((await (client?client.query(sql,[id,serviceId]):query(sql,[id,serviceId]))).rowCount);
}

import { transactionClient } from '@/platform/database';
import type { TransactionContext } from '@/platform/transactions';
import type { AuthorizationRepository } from '../application/authorization';
export function createAuthorizationRepository(context?:TransactionContext):AuthorizationRepository {
  const client=context?transactionClient(context):undefined;
  return {authorizedSendingDomain:(serviceId,domain)=>authorizedSendingDomain(serviceId,domain,client),canAccessInbound:(id,serviceId)=>canAccessInbound(id,serviceId,client)};
}
