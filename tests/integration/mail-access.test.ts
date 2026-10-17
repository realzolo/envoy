import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as capabilities } from "@/app/api/v1/capabilities/route";
import { GET as readInbound } from "@/app/api/v1/inbound-messages/[id]/route";
import { createMessageSchema, mailDiscoverySchema, inboundReceivedEventSchema } from "@/lib/contracts";
import { createDomain, createInboundRoute } from "@/modules/admin/actions";
import { sealSecret } from "@/modules/config/envelope";
import { objectStore } from "@/modules/config/object-store";
import { applyCanonicalEvent } from "@/modules/core/event/service";
import { acceptMessage } from "@/modules/core/message/service";
import { prepareSubmission, markAccepted } from "@/modules/core/routing/engine";
import { getInboundAttachment, getInboundMessage, listInboundMessages } from "@/modules/core/resources/service";
import { persistInbound, processInboundEvent } from "@/modules/inbound/service";
import type { CanonicalInboundMessage } from "@/modules/providers/contracts";
import { hashApiKey } from "@/server/crypto";
import { db, query } from "@/server/database";

const suffix = crypto.randomUUID().replaceAll("-", "");
const product = `prd_access_${suffix}`, domain = `${suffix}.test`;
let domainId: string;
const sid = (role: string) => `svc_access_${role}_${suffix}`;
const key = (role: string) => `envoy_access_${role}_${suffix}`;
const cb = (role: string) => `cb_access_${role}_${suffix}`;
const route = (role: string) => `ir_access_${role}_${suffix}`;
const identity = { serviceId: sid("a"), serviceName: "a", productId: product, product: `Access ${suffix}`, rateLimitPerMinute: 600 };
const request = (role: string, path = "/api/v1/capabilities") => new Request(`https://envoy.test${path}`, { headers: { authorization: `Bearer ${key(role)}` } });
const payload = () => ({ externalMessageId: crypto.randomUUID(), from: "sender@example.net", to: [`visible@${domain}`], cc: ["public@example.net"],
  bcc: [`help@${domain}`, `blind@${domain}`, "private@elsewhere.test"], envelopeRecipients: [`help@${domain}`, `help+alias@${domain}`, `blind@${domain}`],
  subject: "Receipt", text: "Content", messageId: "<original@example.net>", replyTo: ["reply@example.net"], inReplyTo: "<parent@example.net>", references: ["<root@example.net>", "<parent@example.net>"],
  receivedAt: new Date("2099-01-01T00:00:00Z"), attachments: [{ fileName: "receipt.txt", contentType: "text/plain", content: Buffer.from("private attachment") }] });
const persist = (message: CanonicalInboundMessage = payload()) => persistInbound({ providerAccountId: "pa_mock", webhookEndpointId: "pwe_mock", rawEventId: null as unknown as string, message });
async function discover(role: string) {
  const response = await capabilities(request(role));
  expect(response.status).toBe(200);
  const body = await response.json();
  return { ...body, mail: mailDiscoverySchema.parse(body.mail) };
}

beforeAll(async () => {
  await query("INSERT INTO products(id,name) VALUES ($1,$2)", [product,identity.product]);
  const registered = await createDomain({ domain, accountIds: [] }, "test");
  domainId = registered.domainId;
  expect(registered.identities).toEqual([]);
  expect((await query("SELECT id FROM provider_identities WHERE sending_domain_id=$1", [domainId])).rows).toHaveLength(0);
  for (const role of ["a","b","c"]) {
    await query("INSERT INTO services(id,product_id,name) VALUES ($1,$2,$3)", [sid(role),product,role]);
    await query("INSERT INTO service_credentials(id,service_id,key_prefix,key_hash) VALUES ($1,$2,'access_test',$3)", [`cred_${sid(role)}`,sid(role),hashApiKey(key(role))]);
    const sealed = sealSecret({ secret: "access-test-secret" },cb(role),1);
    await query("INSERT INTO callback_endpoints(id,service_id,name,url,secret_ciphertext,encrypted_dek,key_version,subscribed_events) VALUES ($1,$2,$3,'https://callback.test/receipt',$4,$5,$6,ARRAY['inbound.received'])", [cb(role),sid(role),role,sealed.secretCiphertext,sealed.encryptedDek,sealed.keyVersion]);
  }
  // An inbound route can be registered before any outbound provider identity exists.
  const first = await createInboundRoute({ webhookEndpointId: "pwe_mock", domainId, productId: product, serviceId: sid("a"), callbackId: cb("a"), localPartPattern: "help" }, "test");
  await query("UPDATE inbound_routes SET id=$2 WHERE id=$1", [first,route("a")]);
  for (const [role, pattern, owner] of [["alias", "help*", "a"],["b", "bl*", "b"],["visible", "visible", "c"]]) {
    await query("INSERT INTO inbound_routes(id,provider_webhook_endpoint_id,sending_domain_id,local_part_pattern,product_id,service_id,callback_endpoint_id) VALUES ($1,'pwe_mock',$2,$3,$4,$5,$6)", [route(role),domainId,pattern,product,sid(owner),cb(owner)]);
  }
  await query("INSERT INTO sender_grants(id,product_id,service_id,sending_domain_id,from_local_part) VALUES ($1,$2,$3,$4,'help'),($5,$2,$6,$4,NULL)", [`sg_a_${suffix}`,product,sid("a"),domainId,`sg_c_${suffix}`,sid("c")]);
  await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status) VALUES ($1,$2,'pa_mock','verified')", [`pi_access_${suffix}`,domainId]);
  await query("INSERT INTO routing_policies(id,name,product_id,sending_domain_id) VALUES ($1,'Access routing',$2,$3)", [`rp_access_${suffix}`,product,domainId]);
  await query("INSERT INTO routing_targets(id,policy_id,provider_account_id,provider_identity_id) VALUES ($1,$2,'pa_mock',$3)", [`rt_access_${suffix}`,`rp_access_${suffix}`,`pi_access_${suffix}`]);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  const objects = (await query<{ object_key: string }>("SELECT a.object_key FROM inbound_attachments a JOIN inbound_messages i ON i.id=a.inbound_message_id WHERE i.product_id=$1", [product])).rows;
  for (const object of objects) await objectStore().delete(object.object_key);
  await query("DELETE FROM callback_deliveries WHERE endpoint_id IN (SELECT id FROM callback_endpoints WHERE service_id=ANY($1))", [[sid("a"),sid("b"),sid("c")]]);
  await query("DELETE FROM inbound_messages WHERE product_id=$1 OR external_message_id LIKE $2", [product,`quarantine-${suffix}%`]);
  await query("DELETE FROM messages WHERE product_id=$1", [product]);
  await query("DELETE FROM routing_policies WHERE product_id=$1", [product]);
  await query("DELETE FROM products WHERE id=$1", [product]);
  await query("DELETE FROM sending_domains WHERE id=$1", [domainId]);
  await db().end();
});

describe("service mail discovery and inbound ownership", () => {
  it("separates exact/domain grants, scoped routes, configuration and absent evidence", async () => {
    const a = await discover("a");
    expect(a).toMatchObject({ product: { id: product }, service: { id: sid("a") } });
    expect(a.mail.senders).toHaveLength(1);
    expect(a.mail.senders[0]).toMatchObject({ kind: "exact_address",address: `help@${domain}`,sending: { state: "configured",runtimeAvailability: "unknown" },evidence: { lastAcceptedAt: null,lastDeliveredAt: null } });
    expect(a.mail.receivers.map((r: { kind: string }) => r.kind).sort()).toEqual(["exact_address","local_part_pattern"]);
    expect(a.mail.receivers.every((r: { receiving: { state: string; externalReadiness: string }; evidence: { lastReceivedAt: null } }) => r.receiving.state === "configured" && r.receiving.externalReadiness === "unknown" && r.evidence.lastReceivedAt === null)).toBe(true);
    expect(a.mail.callbacks).toMatchObject({ latest: null,lastDeliveredAt: null,businessProcessing: "unknown" });
    expect((await discover("c")).mail.senders[0]).toMatchObject({ kind: "domain",address: null });
    expect((await discover("b")).mail.senders).toEqual([]);
    await query("UPDATE provider_identities SET status='pending' WHERE id=$1", [`pi_access_${suffix}`]);
    try {
      const unverified = await discover("a");
      expect(unverified.mail.senders[0].sending).toMatchObject({ state: "unavailable",reasonCodes: ["NO_ELIGIBLE_ROUTE"] });
      expect(unverified.mail.receivers[0].receiving.state).toBe("configured");
    } finally { await query("UPDATE provider_identities SET status='verified' WHERE id=$1", [`pi_access_${suffix}`]); }
  });

  it("matches all trusted envelope routes, merges aliases per service, isolates Bcc/files/callbacks and deduplicates", async () => {
    const message = payload();
    vi.stubEnv("CLAMAV_HOST", "");
    const first = await persist(message);
    expect(await persist(message)).toBe(first);
    const copies = (await query<{ id: string; service_id: string }>("SELECT id,service_id FROM inbound_messages WHERE provider_account_id='pa_mock' AND external_message_id=$1 ORDER BY service_id", [message.externalMessageId])).rows;
    expect(copies.map(row => row.service_id).sort()).toEqual([sid("a"),sid("b")].sort());
    const aId = copies.find(row => row.service_id === sid("a"))!.id;
    const bId = copies.find(row => row.service_id === sid("b"))!.id;
    const a = (await getInboundMessage(aId,sid("a")))!;
    const b = (await getInboundMessage(bId,sid("b")))!;
    expect(a).toMatchObject({ messageId: message.messageId,replyTo: message.replyTo,inReplyTo: message.inReplyTo,references: message.references,bcc: [`help@${domain}`] });
    expect(a.envelopeRecipients.sort()).toEqual([`help@${domain}`,`help+alias@${domain}`].sort());
    expect(b).toMatchObject({ envelopeRecipients: [`blind@${domain}`],bcc: [`blind@${domain}`] });
    expect(await getInboundMessage(aId,sid("b"))).toBeNull();
    expect(await getInboundAttachment(aId,a.attachments[0].id,sid("b"))).toBeNull();
    expect(await getInboundAttachment(bId,a.attachments[0].id,sid("b"))).toBeNull();
    expect(await (await getInboundAttachment(aId,a.attachments[0].id,sid("a")))!.text()).toBe("private attachment");
    expect((await readInbound(request("b",`/api/v1/inbound-messages/${aId}`),{ params: Promise.resolve({ id: aId }) })).status).toBe(404);
    expect((await listInboundMessages(sid("c"),{ limit: 100 })).data).toEqual([]);
    const callbacks = (await query<{ service_id: string; payload: { data: { envelopeRecipients: string[] } } }>("SELECT e.service_id,c.payload FROM callback_deliveries c JOIN callback_endpoints e ON e.id=c.endpoint_id WHERE c.inbound_message_id=ANY($1)", [copies.map(row => row.id)])).rows;
    expect(callbacks).toHaveLength(2);
    callbacks.forEach(row => inboundReceivedEventSchema.parse(row.payload));
    expect(callbacks.find(row => row.service_id === sid("a"))!.payload.data.envelopeRecipients).not.toContain(`blind@${domain}`);
    const discovered = await discover("a");
    expect(discovered.mail.receivers.every((r: { evidence: { lastReceivedAt: string } }) => r.evidence.lastReceivedAt && new Date(r.evidence.lastReceivedAt).getFullYear() !== 2099)).toBe(true);
    expect(discovered.mail.senders[0].evidence).toEqual({ lastAcceptedAt: null,lastDeliveredAt: null });
    expect(discovered.mail.callbacks.latest).toMatchObject({ status: "pending",attemptCount: 0,deliveredAt: null });
    await query("UPDATE callback_deliveries SET status='delivered',attempt_count=1,delivered_at=now() WHERE inbound_message_id=$1", [aId]);
    expect((await discover("a")).mail.callbacks).toMatchObject({ latest: { status: "delivered" },businessProcessing: "unknown" });
  });

  it("quarantines missing or invalid envelopes despite a matching visible To, and rejects unverified receipts", async () => {
    for (const envelopeRecipients of [undefined,[],["invalid"],[`help@${domain}`,"invalid"]]) {
      const message = { ...payload(),externalMessageId: `quarantine-${suffix}-${crypto.randomUUID()}`,to: [`help@${domain}`],envelopeRecipients,attachments: [] };
      const id = await persist(message);
      expect((await query("SELECT service_id,status,rejection_reason FROM inbound_messages WHERE id=$1", [id])).rows[0]).toMatchObject({ service_id: null,status: "rejected",rejection_reason: "ENVELOPE_RECIPIENT_UNAVAILABLE" });
      expect(await getInboundMessage(id,sid("a"))).toBeNull();
    }
    const noMatch = await persist({ ...payload(),externalMessageId: `quarantine-${suffix}-unmatched`,envelopeRecipients: [`no-route@${domain}`],attachments: [] });
    expect((await query("SELECT service_id,rejection_reason FROM inbound_messages WHERE id=$1", [noMatch])).rows[0]).toMatchObject({ service_id: null,rejection_reason: "NO_INBOUND_ROUTE" });
    const receive = vi.fn();
    await expect(processInboundEvent({ providerAccountId: "pa_mock",webhookEndpointId: "pwe_mock",rawEventId: "raw_unverified",verified: { valid: false,replaySafe: true,nativeType: "inbound",parsed: {} },receive })).rejects.toThrow("Unverified inbound");
    await expect(processInboundEvent({ providerAccountId: "pa_mock",webhookEndpointId: "pwe_mock",rawEventId: "raw_replayed",verified: { valid: true,replaySafe: false,nativeType: "inbound",parsed: {} },receive })).rejects.toThrow("Unverified inbound");
    expect(receive).not.toHaveBeenCalled();
  });

  it("rechecks sender revocation at acceptance and submission after discovery", async () => {
    const input = createMessageSchema.parse({ from: { email: `help@${domain}` },to: [{ email: "customer@example.net" }],subject: "Reply",text: "Hello" });
    expect((await discover("a")).mail.senders[0].authorization).toBe("granted");
    await expect(acceptMessage({ identity,idempotencyKey: crypto.randomUUID(),input: { ...input,from: { email: `other@${domain}` } } })).rejects.toMatchObject({ code: "SENDER_NOT_AUTHORIZED" });
    const queued = await acceptMessage({ identity,idempotencyKey: crypto.randomUUID(),input });
    const submission = (await query<{ id: string }>("SELECT id FROM submissions WHERE message_id=$1", [queued.message.id])).rows[0];
    await query("UPDATE sender_grants SET status='disabled' WHERE id=$1", [`sg_a_${suffix}`]);
    try {
      expect((await discover("a")).mail.senders[0]).toMatchObject({ authorization: "revoked",sending: { state: "unavailable",reasonCodes: ["SENDER_NOT_AUTHORIZED"] } });
      await expect(acceptMessage({ identity,idempotencyKey: crypto.randomUUID(),input })).rejects.toMatchObject({ code: "SENDER_NOT_AUTHORIZED" });
      expect(await prepareSubmission(submission.id)).toBeNull();
      expect((await query("SELECT id FROM submission_attempts WHERE submission_id=$1", [submission.id])).rows).toHaveLength(0);
      expect((await discover("a")).mail.receivers[0].receiving.state).toBe("configured");
    } finally { await query("UPDATE sender_grants SET status='active' WHERE id=$1", [`sg_a_${suffix}`]); }
    const accepted = await acceptMessage({ identity,idempotencyKey: crypto.randomUUID(),input });
    const another = (await query<{ id: string }>("SELECT id FROM submissions WHERE message_id=$1", [accepted.message.id])).rows[0];
    const prepared = await prepareSubmission(another.id);
    if (!prepared || "reconcileAttemptId" in prepared) throw new Error("Expected prepared submission");
    await markAccepted(prepared.attemptId,crypto.randomUUID()); // synthetic provider evidence, no transport call
    const evidence = (await discover("a")).mail.senders[0].evidence;
    expect(evidence.lastAcceptedAt).not.toBeNull();
    expect(evidence.lastDeliveredAt).toBeNull();
    expect((await discover("c")).mail.senders[0].evidence.lastAcceptedAt).toBeNull();
    const external = (await query<{ external_message_id: string }>("SELECT external_message_id FROM submission_attempts WHERE id=$1", [prepared.attemptId])).rows[0].external_message_id;
    await applyCanonicalEvent("pa_mock",null,{ id: crypto.randomUUID(),externalMessageId: external,type: "delivered",occurredAt: new Date(),metadata: {} });
    expect((await discover("a")).mail.senders[0].evidence.lastDeliveredAt).not.toBeNull();
  });

  it("fans out identical exact routes and recovers a partial failure without duplicate successful copies", async () => {
    await createInboundRoute({ webhookEndpointId: "pwe_mock",domainId,productId: product,serviceId: sid("b"),callbackId: cb("b"),localPartPattern: "help" }, "test");
    const store = objectStore();
    const original = store.put.bind(store);
    const upload = vi.spyOn(store,"put").mockImplementationOnce(original).mockRejectedValueOnce(new Error("Temporary storage failure"));
    const message = { ...payload(),envelopeRecipients: [`help@${domain}`] };
    try {
      await expect(persist(message)).rejects.toThrow("Temporary storage failure");
      await persist(message);
      await persist(message);
      const copies = (await query<{ id: string; status: string }>("SELECT id,status FROM inbound_messages WHERE provider_account_id='pa_mock' AND external_message_id=$1", [message.externalMessageId])).rows;
      expect(copies).toHaveLength(2);
      expect(copies.every(row => row.status === "ready")).toBe(true);
      expect((await query("SELECT id FROM inbound_attachments WHERE inbound_message_id=ANY($1)", [copies.map(row => row.id)])).rows).toHaveLength(2);
      expect((await query("SELECT id FROM callback_deliveries WHERE inbound_message_id=ANY($1)", [copies.map(row => row.id)])).rows).toHaveLength(2);
    } finally { upload.mockRestore(); }
  });

  it("blocks callbacks whose endpoint belongs to another service and reports disabled ingress independently", async () => {
    await query("UPDATE inbound_routes SET callback_endpoint_id=$2 WHERE id=$1", [route("b"),cb("a")]);
    try {
      const message = { ...payload(),envelopeRecipients: [`blind@${domain}`] };
      const id = await persist(message);
      expect((await query("SELECT id FROM callback_deliveries WHERE inbound_message_id=$1", [id])).rows).toHaveLength(0);
    } finally { await query("UPDATE inbound_routes SET callback_endpoint_id=$2 WHERE id=$1", [route("b"),cb("b")]); }
    await query("UPDATE inbound_routes SET status='disabled' WHERE id=$1", [route("a")]);
    try {
      const a = await discover("a");
      expect(a.mail.receivers.find((r: { id: string }) => r.id === route("a"))!.receiving).toMatchObject({ state: "unavailable",reasonCodes: ["INBOUND_ROUTE_DISABLED"] });
      expect(a.mail.senders[0].sending.state).toBe("configured");
    } finally { await query("UPDATE inbound_routes SET status='active' WHERE id=$1", [route("a")]); }
  });
});
