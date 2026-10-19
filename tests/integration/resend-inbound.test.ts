import { Webhook } from "svix";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ingestProviderWebhook } from "@/modules/inbound/public";
import { processRawProviderEvent } from "@/modules/outbound/public";
import { db, query } from "@/platform/database";
import { sealSecret } from "@/platform/crypto/envelope";

const suffix = crypto.randomUUID().replaceAll("-", "");
const accountId = `pa_resend_${suffix}`;
const endpointId = `pwe_resend_${suffix}`;
const token = `resend-inbound-${suffix}`;
const domainId = `sd_resend_${suffix}`;
const domain = `resend-${suffix}.test`;
const serviceIds = [`svc_resend_a_${suffix}`, `svc_resend_b_${suffix}`];
const callbackIds = [`cb_resend_a_${suffix}`, `cb_resend_b_${suffix}`];
const emailId = crypto.randomUUID();
const signingSecret = `whsec_${Buffer.from("resend-inbound-integration-key").toString("base64")}`;
const rawIds: string[] = [];

async function webhook(eventId: string) {
  const body = Buffer.from(JSON.stringify({
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: emailId,
      created_at: new Date().toISOString(),
      from: "Sender <sender@example.net>",
      to: [`support@${domain}`], cc: [], bcc: [], received_for: [`support@${domain}`],
      message_id: "<shared-rfc-id@example.net>", subject: "Resend fanout", attachments: []
    }
  }));
  const timestamp = new Date();
  const result = await ingestProviderWebhook("resend", token, {
    rawBody: body,
    headers: {
      "svix-id": eventId,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": new Webhook(signingSecret).sign(eventId, timestamp, body)
    }
  });
  if (result.status !== 202) throw new Error(`Expected accepted Resend webhook: ${result.error}`);
  rawIds.push(result.id);
  return result;
}

beforeAll(async () => {
  const provider = sealSecret({ type: "resend", apiKey: "re_integration_key" }, accountId, 1);
  const security = sealSecret({ type: "resend", signingSecret }, endpointId, 1);
  await query("INSERT INTO provider_accounts(id,type,name,status,public_config,health,quota) VALUES($1,'resend',$1,'active','{}','{}','{}')", [accountId]);
  await query("INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by) VALUES($1,$2,1,$3,$4,$5,'test')", [
    `pc_resend_${suffix}`, accountId, provider.secretCiphertext, provider.encryptedDek, provider.keyVersion
  ]);
  await query("INSERT INTO provider_webhook_endpoints(id,provider_account_id,opaque_token,security_config_ciphertext,security_encrypted_dek,key_version,security_version,security_configured) VALUES($1,$2,$3,$4,$5,$6,1,true)", [
    endpointId, accountId, token, security.secretCiphertext, security.encryptedDek, security.keyVersion
  ]);
  await query("INSERT INTO sending_domains(id,domain) VALUES($1,$2)", [domainId, domain]);
  await query("INSERT INTO domain_inbound_sources(sending_domain_id,provider_account_id) VALUES($1,$2)", [domainId, accountId]);
  for (const [index, serviceId] of serviceIds.entries()) {
    await query("INSERT INTO services(id,name) VALUES($1,$1)", [serviceId]);
    await query("INSERT INTO service_domain_bindings(id,service_id,sending_domain_id,receive_enabled) VALUES($1,$2,$3,true)", [
      `sdb_resend_${index}_${suffix}`, serviceId, domainId
    ]);
    const callback = sealSecret({ secret: `callback-secret-${index}` }, callbackIds[index], 1);
    await query("INSERT INTO callback_endpoints(id,service_id,name,url,secret_ciphertext,encrypted_dek,key_version,subscribed_events) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [
      callbackIds[index], serviceId, "Resend callback", `https://callback${index}.example.test/events`,
      callback.secretCiphertext, callback.encryptedDek, callback.keyVersion, ["inbound.received"]
    ]);
  }
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await query("DELETE FROM outbox_events WHERE aggregate_id=ANY($1) OR payload->>'rawEventId'=ANY($1) OR payload->>'callbackDeliveryId' IN (SELECT id FROM callback_deliveries WHERE endpoint_id=ANY($2))", [rawIds, callbackIds]);
  await query("DELETE FROM callback_deliveries WHERE endpoint_id=ANY($1)", [callbackIds]);
  await query("DELETE FROM inbound_messages WHERE provider_account_id=$1", [accountId]);
  await query("DELETE FROM inbound_receipts WHERE provider_account_id=$1", [accountId]);
  await query("DELETE FROM raw_provider_events WHERE provider_account_id=$1", [accountId]);
  await query("DELETE FROM callback_endpoints WHERE id=ANY($1)", [callbackIds]);
  await query("DELETE FROM service_domain_bindings WHERE sending_domain_id=$1", [domainId]);
  await query("DELETE FROM services WHERE id=ANY($1)", [serviceIds]);
  await query("DELETE FROM sending_domains WHERE id=$1", [domainId]);
  await query("DELETE FROM provider_webhook_endpoints WHERE id=$1", [endpointId]);
  await query("DELETE FROM provider_credentials WHERE provider_account_id=$1", [accountId]);
  await query("DELETE FROM provider_accounts WHERE id=$1", [accountId]);
  await db().end();
});

describe("Resend inbound webhook pipeline", () => {
  it("freezes one domain for both Services and emits one callback per copy across repeated events", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname !== `/emails/receiving/${emailId}`) throw new Error(`Unexpected Resend API call: ${url}`);
      return Response.json({
        object: "email", id: emailId,
        from: "Sender <sender@example.net>", to: [`support@${domain}`], cc: [], bcc: [], reply_to: [],
        received_for: [`support@${domain}`], subject: "Resend fanout", text: "Shared message", html: null,
        message_id: "<shared-rfc-id@example.net>", created_at: new Date().toISOString(),
        headers: {}, attachments: []
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await webhook(`svix-${suffix}-1`);
    const frozen = (await query<{ routes: Array<{ service_id: string }> }>(
      "SELECT routes FROM inbound_receipts WHERE provider_account_id=$1 AND external_message_id=$2", [accountId, emailId]
    )).rows[0];
    expect(frozen.routes.map(route => route.service_id).sort()).toEqual([...serviceIds].sort());
    expect(fetchMock).not.toHaveBeenCalled();

    await processRawProviderEvent(first.id);
    const second = await webhook(`svix-${suffix}-2`);
    await processRawProviderEvent(second.id);

    const copies = (await query<{ id: string; service_id: string; status: string }>(
      "SELECT id,service_id,status FROM inbound_messages WHERE provider_account_id=$1 AND external_message_id=$2 ORDER BY service_id", [accountId, emailId]
    )).rows;
    expect(copies.map(copy => copy.service_id)).toEqual([...serviceIds].sort());
    expect(copies.map(copy => copy.status)).toEqual(["ready", "ready"]);
    const callbacks = (await query<{ endpoint_id: string; inbound_message_id: string }>(
      "SELECT endpoint_id,inbound_message_id FROM callback_deliveries WHERE endpoint_id=ANY($1) ORDER BY endpoint_id", [callbackIds]
    )).rows;
    expect(callbacks.map(callback => callback.endpoint_id)).toEqual([...callbackIds].sort());
    expect(new Set(callbacks.map(callback => callback.inbound_message_id)).size).toBe(2);
  });
});
