import { query } from "@/server/database";
import type { PoolClient } from "pg";

/** These predicates use frozen transport ownership, never caller-supplied domain claims. */
export function outboundDomainAccess(alias: string) {
  return `EXISTS(SELECT 1 FROM service_domain_grants dg JOIN sending_domains dd ON dd.id=dg.sending_domain_id
    JOIN services ds ON ds.id=dg.service_id JOIN products dp ON dp.id=ds.product_id
    WHERE dg.service_id=${alias}.service_id AND dg.sending_domain_id=${alias}.sending_domain_id
      AND dg.status='active' AND dg.send_allowed AND dd.status='active' AND dp.status='active')`;
}
export function inboundDomainAccess(alias: string) {
  // A multi-domain resource is indivisible: fail closed if any private envelope domain was revoked.
  return `(cardinality(${alias}.envelope_recipients)>0 AND NOT EXISTS(
    SELECT 1 FROM unnest(${alias}.envelope_recipients) er WHERE NOT EXISTS(
      SELECT 1 FROM service_domain_grants dg JOIN sending_domains dd ON dd.id=dg.sending_domain_id
      JOIN services ds ON ds.id=dg.service_id JOIN products dp ON dp.id=ds.product_id
      WHERE dg.service_id=${alias}.service_id AND dd.domain=split_part(er,'@',2)
        AND dg.status='active' AND dg.receive_allowed AND dd.status='active' AND dp.status='active')))`;
}
export async function authorizedSendingDomain(serviceId: string, domain: string, client?: PoolClient) {
  const sql = `SELECT d.id FROM sending_domains d JOIN service_domain_grants g ON g.sending_domain_id=d.id
    JOIN services s ON s.id=g.service_id JOIN products p ON p.id=s.product_id
    WHERE g.service_id=$1 AND d.domain=$2 AND g.status='active' AND g.send_allowed AND d.status='active' AND p.status='active'`;
  return (await (client?client.query<{id:string}>(sql,[serviceId,domain.toLowerCase()]):query<{id:string}>(sql,[serviceId,domain.toLowerCase()]))).rows[0]?.id ?? null;
}
export async function canAccessInbound(id:string, serviceId:string, client?:PoolClient) {
  const sql=`SELECT i.id FROM inbound_messages i WHERE i.id=$1 AND i.service_id=$2 AND ${inboundDomainAccess('i')}`;
  return Boolean((await (client?client.query(sql,[id,serviceId]):query(sql,[id,serviceId]))).rowCount);
}
