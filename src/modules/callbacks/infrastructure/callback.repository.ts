import type { Pool, PoolClient } from "pg";
import { eq } from "drizzle-orm";
import { pool, database } from "@/platform/database";
import { callbackEndpoints } from "@/platform/database/schema";
import { inboundDomainAccess, outboundDomainAccess } from "@/modules/identity/infrastructure/authorization";
import type { CallbackClaim } from "../contracts";
import type { CallbackRepository } from "../application/ports";

const callbackEligibility = `(d.event_type='endpoint.test' OR d.event_type=ANY(e.subscribed_events)) AND
  (d.inbound_message_id IS NULL OR EXISTS(SELECT 1 FROM inbound_messages i WHERE i.id=d.inbound_message_id AND i.service_id=e.service_id AND ${inboundDomainAccess('i')} AND i.content_purged_at IS NULL)) AND
  (d.delivery_event_id IS NULL OR EXISTS(SELECT 1 FROM delivery_events de JOIN deliveries dl ON dl.id=de.delivery_id JOIN messages m ON m.id=dl.message_id WHERE de.id=d.delivery_event_id AND m.service_id=e.service_id AND ${outboundDomainAccess('m')} AND m.content_purged_at IS NULL)) AND
  (d.submission_event_id IS NULL OR EXISTS(SELECT 1 FROM submission_events se JOIN submissions s ON s.id=se.submission_id JOIN messages m ON m.id=s.message_id WHERE se.id=d.submission_event_id AND m.service_id=e.service_id AND ${outboundDomainAccess('m')} AND m.content_purged_at IS NULL))`;

export function callbackRepository(client: Pool | PoolClient = pool()): CallbackRepository {
  const orm = database(client);
  return {
    async claim(id) {
      const row = (await client.query<{
        id: string; endpoint_id: string; url: string; secret_ciphertext: string; encrypted_dek: string;
        key_version: string; eligible: boolean; payload: Record<string, unknown>; attempt_count: number;
      }>(`WITH enabled_endpoint AS MATERIALIZED (
        SELECT e.* FROM callback_endpoints e WHERE e.status='active'
          AND e.id=(SELECT endpoint_id FROM callback_deliveries WHERE id=$1) FOR SHARE
      ) UPDATE callback_deliveries d SET status='delivering',attempt_count=attempt_count+1,updated_at=now()
      FROM enabled_endpoint e WHERE d.id=$1 AND e.id=d.endpoint_id AND d.next_attempt_at<=now()
        AND d.payload_purged_at IS NULL AND (d.status IN ('pending','retrying') OR (d.status='delivering' AND d.updated_at<now()-interval '2 minutes'))
      RETURNING d.id,d.endpoint_id,e.url,e.secret_ciphertext,e.encrypted_dek,e.key_version,d.payload,d.attempt_count,
        ${callbackEligibility} AS eligible`, [id])).rows[0];
      if (!row) return null;
      return { id: row.id, endpointId: row.endpoint_id, url: row.url, eligible: row.eligible, payload: row.payload,
        secretCiphertext: row.secret_ciphertext, encryptedDek: row.encrypted_dek, keyVersion: row.key_version, attempt: row.attempt_count } satisfies CallbackClaim;
    },
    async recoverPausedClaim(id) {
      await client.query(`UPDATE callback_deliveries d SET status='dead_letter',last_error='Callback endpoint paused; expired attempt recovered',updated_at=now()
        FROM callback_endpoints e WHERE d.id=$1 AND e.id=d.endpoint_id AND e.status='disabled'
        AND d.status='delivering' AND d.updated_at<now()-interval '2 minutes'`, [id]);
    },
    async currentDispatch(id, attempt) {
      const row = (await client.query<{ eligible: boolean; url: string; secret_ciphertext: string }>(`SELECT ${callbackEligibility} AS eligible,e.url,e.secret_ciphertext
        FROM callback_deliveries d JOIN callback_endpoints e ON e.id=d.endpoint_id
        WHERE d.id=$1 AND d.status='delivering' AND d.attempt_count=$2 AND d.payload_purged_at IS NULL
          AND e.status='active' AND d.updated_at>clock_timestamp()-interval '2 minutes'`, [id, attempt])).rows[0];
      return row ? { eligible: row.eligible, url: row.url, secretCiphertext: row.secret_ciphertext } : null;
    },
    async markDelivered(id, attempt, status) {
      await client.query("UPDATE callback_deliveries SET status='delivered',response_code=$2,last_error=NULL,delivered_at=now(),updated_at=now() WHERE id=$1 AND status='delivering' AND attempt_count=$3", [id, status, attempt]);
    },
    async recordFailure(id, attempt, failure) {
      const row = (await client.query<{ next_attempt_at: Date }>(`UPDATE callback_deliveries SET status=$2,last_error=$3,response_code=$4,
        next_attempt_at=now()+$5*interval '1 second',updated_at=now() WHERE id=$1 AND status='delivering' AND attempt_count=$6 RETURNING next_attempt_at`,
      [id, failure.dead ? "dead_letter" : "retrying", failure.message, failure.responseCode, failure.delaySeconds, attempt])).rows[0];
      return row?.next_attempt_at ?? null;
    },
    async enqueue(id, outboxId, availableAt) {
      await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'callback',$2,'callback.requested',$3,COALESCE($4,now()))", [outboxId, id, { callbackDeliveryId: id }, availableAt ?? null]);
    },
    async deadLetter(id, message) {
      await client.query("UPDATE callback_deliveries SET status='dead_letter',last_error=$2,updated_at=now() WHERE id=$1 AND status NOT IN ('delivered','terminated')", [id, message]);
    },
    async terminate(id) {
      return !!(await client.query("UPDATE callback_deliveries SET status='terminated',terminated_at=clock_timestamp(),updated_at=now() WHERE id=$1 AND status='dead_letter' RETURNING id", [id])).rowCount;
    },
    async activeService(id) {
      return !!(await client.query("SELECT s.id FROM services s WHERE s.id=$1 AND s.status='active'", [id])).rowCount;
    },
    async createEndpoint(id, input, secret) {
      await orm.insert(callbackEndpoints).values({ id, serviceId: input.serviceId, name: input.name, url: input.url, ...secret, subscribedEvents: input.events });
    },
    async setEnabled(id, enabled) {
      return !!(await client.query("UPDATE callback_endpoints SET status=$2,updated_at=now() WHERE id=$1 AND (NOT $3 OR url IS NOT NULL) RETURNING id", [id, enabled ? "active" : "disabled", enabled])).rowCount;
    },
    async stopPending(id, events) {
      await client.query(`UPDATE callback_deliveries SET status='dead_letter',last_error=$3,updated_at=now()
        WHERE endpoint_id=$1 AND status IN ('pending','retrying') AND ($2::text[] IS NULL OR NOT(event_type=ANY($2)))`,
      [id, events ?? null, events ? "CALLBACK_EVENT_NOT_SUBSCRIBED" : "Callback endpoint disabled by operator"]);
    },
    async lockEndpoint(id) { return (await client.query<{ status: string }>("SELECT status FROM callback_endpoints WHERE id=$1 FOR UPDATE", [id])).rows[0] ?? null; },
    async hasInFlight(id) { return !!(await client.query("SELECT id FROM callback_deliveries WHERE endpoint_id=$1 AND status='delivering' LIMIT 1", [id])).rowCount; },
    async replaceSecret(id, secret) { await orm.update(callbackEndpoints).set({ ...secret, updatedAt: new Date().toISOString() }).where(eq(callbackEndpoints.id, id)); },
    async resetDeadLetters(scope) {
      return (await client.query<{ id: string }>(`UPDATE callback_deliveries d SET status='pending',attempt_count=0,next_attempt_at=now(),last_error=NULL,updated_at=now()
        FROM callback_endpoints e WHERE d.endpoint_id=e.id AND d.status='dead_letter' AND d.payload_purged_at IS NULL
        AND e.status='active' AND d.event_type=ANY(e.subscribed_events) AND ($1::text IS NULL OR d.endpoint_id=$1) AND ($2::text IS NULL OR d.id=$2) RETURNING d.id`,
      [scope.endpointId ?? null, scope.deliveryId ?? null])).rows.map(row => row.id);
    },
    async isActive(id) { return !!(await client.query("SELECT id FROM callback_endpoints WHERE id=$1 AND status='active'", [id])).rowCount; },
    async createTest(id, endpointId, payload) { await client.query("INSERT INTO callback_deliveries(id,endpoint_id,event_type,payload) VALUES ($1,$2,'endpoint.test',$3)", [id, endpointId, payload]); },
    async updateEvents(id, events) { return !!(await client.query("UPDATE callback_endpoints SET subscribed_events=$2,updated_at=now() WHERE id=$1 AND url IS NOT NULL RETURNING id", [id, events])).rowCount; },
    async audit(actor, action, resourceType, id, details = {}) {
      await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES($1,$2,$3,$4,$5)", [actor, action, resourceType, id, details]);
    },
  };
}
