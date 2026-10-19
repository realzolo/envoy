import { query } from "@/server/database";
import type { PoolClient } from "pg";

/** SQL expressions passed here come from internal queries, never request input. */
export function domainPermission(serviceId: string, domainId: string, permission: "send" | "receive") {
  return `EXISTS(SELECT 1 FROM service_domain_grants dg JOIN sending_domains dd ON dd.id=${domainId}
    JOIN services ds ON ds.id=dg.service_id JOIN products dp ON dp.id=ds.product_id
    WHERE dg.service_id=${serviceId} AND (dg.sending_domain_id=dd.id OR dg.sending_domain_id IS NULL)
      AND dg.status='active' AND dg.${permission}_allowed AND dd.status='active' AND dp.status='active')`;
}

/** Merge additive exact-domain and ALL grants into one discovery row per domain. */
export function effectiveDomainGrants(serviceId: string, domainId: string) {
  return `SELECT CASE WHEN bool_or(dg.status='active') THEN 'active' ELSE 'disabled' END AS status,
    bool_or(dg.status='active' AND dg.send_allowed) AS send_allowed,
    bool_or(dg.status='active' AND dg.receive_allowed) AS receive_allowed,
    sum(dg.revision)::integer AS revision
    FROM service_domain_grants dg
    WHERE dg.service_id=${serviceId} AND (dg.sending_domain_id=${domainId} OR (dg.sending_domain_id IS NULL AND dg.status='active'))
    HAVING count(*)>0`;
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
