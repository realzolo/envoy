import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestProviderWebhook, replayRawEvent } from "@/modules/inbound/public";
import { processRawProviderEvent } from "@/modules/outbound/public";
import { db, query } from "@/platform/database";
import { objectStore } from "@/platform/storage/object-store";

const tag = crypto.randomUUID().replaceAll("-", "");
const domainId = `sd_replay_${tag}`;
const domain = `replay-${tag}.test`;
const services = [0, 1, 2].map(index => `svc_replay_${index}_${tag}`);
const freshMessageId = `mail_fresh_${tag}`;
const legacyMessageId = `mail_legacy_${tag}`;
const externalIds = [freshMessageId, legacyMessageId];
const rawIds: string[] = [];

async function acceptWebhook(eventId: string, externalMessageId: string) {
  const accepted = await ingestProviderWebhook("mock", "test-endpoint", {
    rawBody: Buffer.from(JSON.stringify({
      id: eventId,
      type: "inbound.received",
      externalMessageId,
      envelopeRecipients: [`help@${domain}`],
      from: "sender@example.net",
      to: [`help@${domain}`],
      subject: "Replay after binding",
      text: "Message body",
      attachments: externalMessageId === freshMessageId ? [{
        fileName: "receipt.txt", contentType: "text/plain", contentBase64: Buffer.from("attachment body").toString("base64"),
      }] : [],
    })),
    headers: { authorization: "Bearer test-webhook-token" },
  });
  if (accepted.status !== 202) throw new Error("Expected accepted webhook");
  rawIds.push(accepted.id);
  return accepted.id;
}

async function bindService(index: number) {
  await query("INSERT INTO service_domain_bindings(id,service_id,sending_domain_id,receive_enabled) VALUES($1,$2,$3,true)", [
    `sdb_replay_${index}_${tag}`, services[index], domainId,
  ]);
}

beforeAll(async () => {
  await query("INSERT INTO sending_domains(id,domain) VALUES($1,$2)", [domainId, domain]);
  for (const service of services) await query("INSERT INTO services(id,name) VALUES($1,$1)", [service]);
});

afterAll(async () => {
  await query("DELETE FROM outbox_events WHERE aggregate_id=ANY($1) OR payload->>'rawEventId'=ANY($1)", [rawIds]);
  const attachments = (await query<{ id: string; object_key: string }>(
    "SELECT a.id,a.object_key FROM inbound_attachments a JOIN inbound_messages m ON m.id=a.inbound_message_id WHERE m.external_message_id=ANY($1)", [externalIds],
  )).rows;
  for (const attachment of attachments) await objectStore().delete(attachment.object_key);
  await query("DELETE FROM attachment_safety WHERE resource_id=ANY($1)", [attachments.map(attachment => attachment.id)]);
  await query("DELETE FROM inbound_messages WHERE provider_account_id='pa_mock' AND external_message_id=ANY($1)", [externalIds]);
  await query("DELETE FROM inbound_receipts WHERE provider_account_id='pa_mock' AND external_message_id=ANY($1)", [externalIds]);
  await query("DELETE FROM raw_provider_events WHERE id=ANY($1)", [rawIds]);
  await query("DELETE FROM service_domain_bindings WHERE sending_domain_id=$1", [domainId]);
  await query("DELETE FROM services WHERE id=ANY($1)", [services]);
  await query("DELETE FROM sending_domains WHERE id=$1", [domainId]);
  await db().end();
});

describe("admin replay of unrouted inbound mail", () => {
  it("keeps new unbound mail ready for administrators and recovers legacy rejected mail on replay", async () => {
    const first = await acceptWebhook(`event_first_${tag}`, freshMessageId);
    await processRawProviderEvent(first);
    const administratorCopy = (await query<{
      id: string; service_id: string | null; status: string; rejection_reason: string | null; text_body: string;
    }>("SELECT id,service_id,status,rejection_reason,text_body FROM inbound_messages WHERE external_message_id=$1", [freshMessageId])).rows;
    expect(administratorCopy).toEqual([{
      id: expect.any(String), service_id: null, status: "ready", rejection_reason: null, text_body: "Message body",
    }]);
    const attachments = (await query<{ file_name: string; service_id: string | null; scope: string }>(
      "SELECT a.file_name,s.service_id,s.scope FROM inbound_attachments a JOIN attachment_safety s ON s.resource_id=a.id WHERE a.inbound_message_id=$1", [administratorCopy[0].id],
    )).rows;
    expect(attachments).toEqual([{ file_name: "receipt.txt", service_id: null, scope: "administrator" }]);

    await replayRawEvent(first, "test");
    await processRawProviderEvent(first);
    expect((await query("SELECT id FROM inbound_messages WHERE id=$1", [administratorCopy[0].id])).rowCount).toBe(1);

    await bindService(0);
    await bindService(1);
    const duplicate = await acceptWebhook(`event_duplicate_${tag}`, freshMessageId);
    await processRawProviderEvent(duplicate);
    await replayRawEvent(first, "test");
    await processRawProviderEvent(first);
    expect((await query("SELECT service_id FROM inbound_messages WHERE external_message_id=$1 AND service_id IS NOT NULL", [freshMessageId])).rows).toEqual([]);

    await query("UPDATE service_domain_bindings SET receive_enabled=false WHERE sending_domain_id=$1", [domainId]);
    const legacy = await acceptWebhook(`event_legacy_${tag}`, legacyMessageId);
    await processRawProviderEvent(legacy);
    const oldCopy = (await query<{ id: string }>(
      "SELECT id FROM inbound_messages WHERE external_message_id=$1 AND service_id IS NULL", [legacyMessageId],
    )).rows[0];
    await query("UPDATE inbound_messages SET status='rejected',rejection_reason='NO_RECEIVING_SERVICE' WHERE id=$1", [oldCopy.id]);
    await query("UPDATE service_domain_bindings SET receive_enabled=true WHERE sending_domain_id=$1", [domainId]);

    await replayRawEvent(legacy, "test");
    expect((await query("SELECT id FROM inbound_messages WHERE id=$1", [oldCopy.id])).rowCount).toBe(0);
    await processRawProviderEvent(legacy);
    const copies = (await query<{ service_id: string; status: string }>(
      "SELECT service_id,status FROM inbound_messages WHERE external_message_id=$1 ORDER BY service_id", [legacyMessageId],
    )).rows;
    expect(copies).toEqual(services.slice(0, 2).map(service_id => ({ service_id, status: "ready" })));

    await bindService(2);
    await replayRawEvent(legacy, "test");
    await processRawProviderEvent(legacy);
    const afterReplay = (await query<{ service_id: string }>(
      "SELECT service_id FROM inbound_messages WHERE external_message_id=$1 ORDER BY service_id", [legacyMessageId],
    )).rows;
    expect(afterReplay.map(row => row.service_id)).toEqual(services.slice(0, 2));
  });
});
