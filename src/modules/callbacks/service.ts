import { createHmac } from "node:crypto";
import { openSecret } from "@/modules/config/envelope";
import { CallbackUrlPolicyError, postCallback, resolveCallbackTarget } from "@/modules/callbacks/url-policy";
import { query, transaction } from "@/server/database";
import { createId } from "@/server/ids";

export async function deliverCallback(callbackDeliveryId: string) {
  // The database is the retry clock. A duplicate job cannot reclaim a live delivery.
  const row = (await query<{
    id: string; endpoint_id: string; url: string; secret_ciphertext: string; encrypted_dek: string; key_version: string;
    eligible: boolean; secret_version: number; endpoint_status: string; payload: Record<string, unknown>; attempt_count: number
  }>(`UPDATE callback_deliveries d SET status='delivering',attempt_count=attempt_count+1,updated_at=now()
    FROM callback_endpoints e WHERE d.id=$1 AND e.id=d.endpoint_id AND d.next_attempt_at<=now()
      AND d.payload_purged_at IS NULL AND (d.status IN ('pending','retrying') OR (d.status='delivering' AND d.updated_at<now()-interval '2 minutes'))
    RETURNING d.id,d.endpoint_id,e.url,e.status AS endpoint_status,e.secret_ciphertext,e.encrypted_dek,e.key_version,e.secret_version,d.payload,d.attempt_count,
      (d.event_type='endpoint.test' OR d.event_type=ANY(e.subscribed_events)) AND
      (d.inbound_message_id IS NULL OR EXISTS(SELECT 1 FROM inbound_messages i WHERE i.id=d.inbound_message_id AND i.service_id=e.service_id AND i.content_purged_at IS NULL)) AND
      (d.delivery_event_id IS NULL OR EXISTS(SELECT 1 FROM delivery_events de JOIN deliveries dl ON dl.id=de.delivery_id JOIN messages m ON m.id=dl.message_id WHERE de.id=d.delivery_event_id AND m.service_id=e.service_id AND m.content_purged_at IS NULL)) AND
      (d.submission_event_id IS NULL OR EXISTS(SELECT 1 FROM submission_events se JOIN submissions s ON s.id=se.submission_id JOIN messages m ON m.id=s.message_id WHERE se.id=d.submission_event_id AND m.service_id=e.service_id AND m.content_purged_at IS NULL)) AS eligible`, [callbackDeliveryId])).rows[0];
  if (!row) return;
  try {
    if (!row.eligible) throw new CallbackUrlPolicyError("CALLBACK_BINDING_OR_SUBSCRIPTION_INVALID");
    if (row.endpoint_status !== "active") throw new CallbackUrlPolicyError("Callback endpoint is disabled");
    const target = await resolveCallbackTarget(row.url);
    const secret = openSecret<{ secret: string }>({ secretCiphertext: row.secret_ciphertext, encryptedDek: row.encrypted_dek, keyVersion: row.key_version }, row.endpoint_id, row.secret_version).secret;
    const body = JSON.stringify(row.payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    const response = await postCallback(target, body, {
      "content-type": "application/json", "x-envoy-id": String(row.payload.id),
      "x-envoy-key-version": String(row.secret_version),
      "x-envoy-timestamp": timestamp, "x-envoy-signature": `v1=${signature}`
    });
    if (response.status < 200 || response.status >= 300) {
      await scheduleFailure(row, response.body || response.statusText, response.status);
      return;
    }
    await query("UPDATE callback_deliveries SET status='delivered',response_code=$2,last_error=NULL,delivered_at=now(),updated_at=now() WHERE id=$1 AND status='delivering' AND attempt_count=$3", [row.id, response.status, row.attempt_count]);
  } catch (error) {
    await scheduleFailure(row, error instanceof Error ? error.message : "Callback delivery failed", null, error instanceof CallbackUrlPolicyError);
  }
}

async function scheduleFailure(row: { id: string; attempt_count: number }, message: string, responseCode: number | null = null, terminal = false) {
  await transaction(async client => {
    const dead = terminal || row.attempt_count >= 10;
    const delaySeconds = Math.min(3600, 60 * 2 ** (row.attempt_count - 1));
    const updated = await client.query<{ next_attempt_at: Date }>(`UPDATE callback_deliveries SET status=$2,last_error=$3,response_code=$4,
      next_attempt_at=now()+$5*interval '1 second',updated_at=now() WHERE id=$1 AND status='delivering' AND attempt_count=$6 RETURNING next_attempt_at`, [row.id, dead ? "dead_letter" : "retrying", message.slice(0, 2000), responseCode, delaySeconds, row.attempt_count]);
    if (!dead && updated.rows[0]) await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,available_at) VALUES ($1,'callback',$2,'callback.requested',$3,$4)", [createId("out"), row.id, { callbackDeliveryId: row.id }, updated.rows[0].next_attempt_at]);
  });
}

export async function deadLetterCallback(id: string, message: string) {
  await query("UPDATE callback_deliveries SET status='dead_letter',last_error=$2,updated_at=now() WHERE id=$1 AND status NOT IN ('delivered','terminated')", [id, message]);
}

/** Dead letter retains recoverable work; termination is an explicit, audited decision to stop it. */
export async function terminateCallback(id: string, actor: string) {
  return transaction(async client => {
    const row = await client.query(`UPDATE callback_deliveries SET status='terminated',terminated_at=clock_timestamp(),updated_at=now()
      WHERE id=$1 AND status='dead_letter' RETURNING id`,[id]);
    if (!row.rowCount) throw new Error("Only dead-letter callbacks can be terminated");
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id) VALUES($1,'callback_delivery.terminate','callback_delivery',$2)",[actor,id]);
    return { id,status:"terminated" };
  });
}
