import { createHmac } from "node:crypto";
import { openSecret } from "@/modules/config/envelope";
import { query } from "@/server/database";

export async function deliverCallback(callbackDeliveryId: string) {
  const row = (await query<{
    id: string;
    url: string;
    status: string;
    secret_ciphertext: string;
    encrypted_dek: string;
    key_version: string;
    secret_version: number;
    payload: Record<string, unknown>;
    attempt_count: number
  }>(`SELECT d.id,e.url,d.status,e.secret_ciphertext,e.encrypted_dek,e.key_version,e.secret_version,d.payload,d.attempt_count FROM callback_deliveries d JOIN callback_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1 AND e.status='active' AND d.status<>'delivered'`, [callbackDeliveryId])).rows[0];
  if (!row) return;
  const secret = openSecret<{ secret: string }>({
    secretCiphertext: row.secret_ciphertext,
    encryptedDek: row.encrypted_dek,
    keyVersion: row.key_version
  }, (await query<{
    endpoint_id: string
  }>("SELECT endpoint_id FROM callback_deliveries WHERE id=$1", [callbackDeliveryId])).rows[0].endpoint_id, row.secret_version).secret;
  const body = JSON.stringify(row.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  await query("UPDATE callback_deliveries SET status='delivering',attempt_count=attempt_count+1,updated_at=now() WHERE id=$1", [row.id]);
  let response: Response;
  try {
    response = await fetch(row.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-envoy-id": String(row.payload.id),
        "x-envoy-timestamp": timestamp,
        "x-envoy-signature": `v1=${signature}`
      },
      body,
      signal: AbortSignal.timeout(10_000)
    })
  } catch (error) {
    await query("UPDATE callback_deliveries SET status='retrying',last_error=$2,next_attempt_at=now()+interval '1 minute',updated_at=now() WHERE id=$1", [row.id, error instanceof Error ? error.message : "Network error"]);
    throw error
  }
  if (!response.ok) {
    const text = (await response.text()).slice(0, 500);
    await query("UPDATE callback_deliveries SET status='retrying',response_code=$2,last_error=$3,next_attempt_at=now()+interval '1 minute',updated_at=now() WHERE id=$1", [row.id, response.status, text || response.statusText]);
    throw new Error(`Callback returned HTTP ${response.status}`)
  }
  await query("UPDATE callback_deliveries SET status='delivered',response_code=$2,last_error=NULL,delivered_at=now(),updated_at=now() WHERE id=$1", [row.id, response.status])
}

export async function deadLetterCallback(id: string, message: string) {
  await query("UPDATE callback_deliveries SET status='dead_letter',last_error=$2,updated_at=now() WHERE id=$1", [id, message])
}
