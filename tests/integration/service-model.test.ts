import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMessageSchema } from "@/lib/contracts";
import { createDomain } from "@/modules/channels/public";
import { createService, discoverMail, issueServiceCredential, rotateServiceCredential, toggleService, updateService, type ServiceIdentity } from "@/modules/identity/public";
import { createInboundRoute, persistInbound, getInboundMessage } from "@/modules/inbound/public";
import { acceptMessage, createRoutingPolicy, getMessage, prepareSubmission, simulateRouting } from "@/modules/outbound/public";
import { addSuppression, createSuppression, listSuppressions, removeSuppression } from "@/modules/suppressions/public";
import { authenticateService } from "@/server/auth";
import { db, query } from "@/platform/database";

const tag = crypto.randomUUID();
const serviceIds: string[] = [];
const domains: string[] = [];
const receiptIds: string[] = [];
let a: Awaited<ReturnType<typeof service>>;
let b: Awaited<ReturnType<typeof service>>;
let c: Awaited<ReturnType<typeof service>>;
const configuration = (name: string) => ({ serviceName: name, sending: { mode: "all" as const }, receiving: { mode: "all" as const } });
const authenticate = (key: string) => authenticateService(new Request("https://envoy.test", { headers: { authorization: `Bearer ${key}` } }));

async function service() {
  const credential = await createService(configuration(`Service ${crypto.randomUUID()}`), "test");
  serviceIds.push(credential.serviceId);
  return { ...credential, identity: (await authenticate(credential.key)) as ServiceIdentity };
}
async function domain() {
  const name = `service-${crypto.randomUUID()}.test`;
  const { domainId } = await createDomain({ domain: name, accountIds: [] }, "test");
  domains.push(domainId);
  const identityId = `pi_${domainId}`;
  await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status) VALUES($1,$2,'pa_mock','verified')", [identityId, domainId]);
  return { domainId, identityId, name };
}
function policy(d: Awaited<ReturnType<typeof domain>>, services: { mode: "all" | "selected"; serviceIds?: string[] }) {
  return { name: `Policy ${crypto.randomUUID()}`, domainId: d.domainId, services, targets: [{ accountId: "pa_mock", identityId: d.identityId }] };
}
async function message(owner: typeof a, d: Awaited<ReturnType<typeof domain>>, email = "recipient@example.net", listId?: string) {
  const accepted = await acceptMessage({ identity: owner.identity, idempotencyKey: crypto.randomUUID(), input: createMessageSchema.parse({
    from: { email: `hello@${d.name}` }, to: [{ email }], subject: "Service isolation", text: "Body", metadata: listId ? { listId } : {},
  }) });
  const delivery = (await query<{ compliance_status: string }>("SELECT compliance_status FROM deliveries WHERE message_id=$1", [accepted.message.id])).rows[0];
  return { ...accepted.message, suppressed: delivery.compliance_status === "suppressed" };
}

beforeAll(async () => { a = await service(); b = await service(); c = await service(); });
afterAll(async () => {
  await query("DELETE FROM callback_deliveries WHERE inbound_message_id IN (SELECT id FROM inbound_messages WHERE service_id=ANY($1))", [serviceIds]);
  await query("DELETE FROM inbound_messages WHERE service_id=ANY($1)", [serviceIds]);
  await query("DELETE FROM inbound_receipts WHERE external_message_id=ANY($1)", [receiptIds]);
  await query("DELETE FROM messages WHERE service_id=ANY($1)", [serviceIds]);
  await query("DELETE FROM routing_policies WHERE sending_domain_id=ANY($1)", [domains]);
  await query("DELETE FROM suppressions WHERE source=$1 OR service_id=ANY($2)", [tag, serviceIds]);
  await query("DELETE FROM services WHERE id=ANY($1)", [serviceIds]);
  await query("DELETE FROM sending_domains WHERE id=ANY($1)", [domains]);
  await db().end();
});

describe("Service identity and isolation", () => {
  it("creates directly with no mail permissions and enforces a globally unique name without issuing orphan keys", async () => {
    const name = `Empty ${crypto.randomUUID()}`;
    const config = { serviceName: name, sending: { mode: "none" }, receiving: { mode: "none" } };
    const created = await createService(config, "test");
    serviceIds.push(created.serviceId);
    expect(await authenticate(created.key)).toMatchObject({ serviceId: created.serviceId, serviceName: name });
    expect((await discoverMail((await authenticate(created.key))!)).domains).toEqual([]);
    await expect(createService({ ...config, serviceName: name.toUpperCase() }, "test")).rejects.toThrow();
    expect((await query("SELECT id FROM services WHERE lower(name)=lower($1)", [name])).rowCount).toBe(1);
    expect((await query("SELECT id FROM service_credentials WHERE service_id=$1", [created.serviceId])).rowCount).toBe(1);
  });

  it("shares one target across selected services, includes future services only in all scope, and keeps discovery, simulation and dispatch aligned", async () => {
    const d = await domain();
    const input = policy(d, { mode: "selected", serviceIds: [a.serviceId, b.serviceId] });
    const policyId = await createRoutingPolicy(input, "test");
    expect((await query("SELECT id FROM routing_targets WHERE policy_id=$1", [policyId])).rowCount).toBe(1);
    for (const owner of [a, b]) {
      expect((await discoverMail(owner.identity)).domains.find(item => item.id === d.domainId)?.sending.state).toBe("configured");
      expect((await simulateRouting({ domainId: d.domainId, serviceId: owner.serviceId })).chosen?.policy_id).toBe(policyId);
      const accepted = await message(owner, d);
      const submission = (await query<{ id: string }>("SELECT id FROM submissions WHERE message_id=$1", [accepted.id])).rows[0].id;
      expect(await prepareSubmission(submission)).toMatchObject({ routingSnapshot: { policy: { id: policyId } } });
    }
    expect((await discoverMail(c.identity)).domains.find(item => item.id === d.domainId)?.sending.state).toBe("unavailable");
    expect((await simulateRouting({ domainId: d.domainId, serviceId: c.serviceId })).candidates).toEqual([]);
    await expect(message(c, d)).rejects.toThrow();
    const target = (await query<{ id: string }>("SELECT id FROM routing_targets WHERE policy_id=$1", [policyId])).rows[0];
    await query("UPDATE routing_targets SET status='circuit_open',circuit_open_until=now()+interval '1 hour' WHERE id=$1", [target.id]);
    await createRoutingPolicy({ ...input, services: { mode: "all" } }, "test", policyId);
    expect((await query("SELECT id,status FROM routing_targets WHERE policy_id=$1", [policyId])).rows).toEqual([{ id: target.id, status: "circuit_open" }]);
    await query("UPDATE routing_targets SET status='active',circuit_open_until=NULL WHERE id=$1", [target.id]);
    expect((await query("SELECT * FROM routing_policy_services WHERE policy_id=$1", [policyId])).rowCount).toBe(0);
    const future = await service();
    expect((await discoverMail(future.identity)).domains.find(item => item.id === d.domainId)?.sending.state).toBe("configured");
    expect((await simulateRouting({ domainId: d.domainId, serviceId: future.serviceId })).chosen?.policy_id).toBe(policyId);
    await expect(createRoutingPolicy({ ...input, services: { mode: "selected", serviceIds: [] } }, "test", policyId)).rejects.toThrow("Select at least one service");
    await expect(createRoutingPolicy({ ...input, services: { mode: "selected", serviceIds: ["missing"] } }, "test", policyId)).rejects.toThrow("must exist");
    expect((await simulateRouting({ domainId: d.domainId, serviceId: future.serviceId })).chosen?.policy_id).toBe(policyId);
  });

  it("pauses every key, content access, inbound routing and queued dispatch for one service and resumes its retained configuration", async () => {
    const d = await domain();
    await createRoutingPolicy(policy(d, { mode: "all" }), "test");
    const queued = await message(a, d);
    const submission = (await query<{ id: string }>("SELECT id FROM submissions WHERE message_id=$1", [queued.id])).rows[0].id;
    const key = await issueServiceCredential(a.serviceId, "test");
    await createInboundRoute({ serviceId: a.serviceId, domainId: d.domainId, webhookEndpointId: "pwe_mock" }, "test");
    const receive = async () => {
      const externalMessageId = crypto.randomUUID(); receiptIds.push(externalMessageId);
      return persistInbound({ providerAccountId: "pa_mock", webhookEndpointId: "pwe_mock", rawEventId: null!, message: {
        externalMessageId, from: "author@example.net", to: [`help@${d.name}`], cc: [], bcc: [], envelopeRecipients: [`help@${d.name}`], subject: "Inbound", text: "Body", attachments: [], receivedAt: new Date(),
      } });
    };
    const inbound = await receive();
    const revision = (await query<{ configuration_revision: number }>("SELECT configuration_revision FROM services WHERE id=$1", [a.serviceId])).rows[0].configuration_revision;
    await toggleService(a.serviceId, false, "test");
    expect(await authenticate(a.key)).toBeNull(); expect(await authenticate(key.key)).toBeNull();
    expect(await authenticate(b.key)).not.toBeNull();
    expect(await getMessage(queued.id, a.serviceId)).toBeNull(); expect(await getInboundMessage(inbound, a.serviceId)).toBeNull();
    await expect(issueServiceCredential(a.serviceId, "test")).rejects.toThrow("Active service");
    await expect(rotateServiceCredential(key.id, "test")).rejects.toThrow("Active service");
    await expect(updateService(a.serviceId, configuration(a.identity.serviceName), revision, "test")).rejects.toThrow("changed");
    expect(await prepareSubmission(submission)).toBeNull();
    const unrouted = await receive();
    expect((await query("SELECT service_id,status FROM inbound_messages WHERE id=$1", [unrouted])).rows[0]).toEqual({ service_id: null, status: "rejected" });
    await toggleService(a.serviceId, true, "test");
    expect(await authenticate(a.key)).toMatchObject({ serviceId: a.serviceId }); expect(await authenticate(key.key)).not.toBeNull();
    expect(await getMessage(queued.id, a.serviceId)).not.toBeNull(); expect(await getInboundMessage(inbound, a.serviceId)).not.toBeNull();
    expect((await query("SELECT configuration_revision FROM services WHERE id=$1", [a.serviceId])).rows[0].configuration_revision).toBe(revision + 2);
  });

  it("isolates recipient and list suppressions by service while global rules affect all services", async () => {
    const d = await domain(); await createRoutingPolicy(policy(d, { mode: "all" }), "test");
    const email = `isolation-${tag}@example.net`;
    const rule = await createSuppression({ serviceId: a.serviceId, email, scope: "service", reason: "manual" });
    expect((await message(a, d, email)).suppressed).toBe(true); expect((await message(b, d, email)).suppressed).toBe(false);
    expect(await removeSuppression(rule.id, b.serviceId)).toBeNull(); await removeSuppression(rule.id, a.serviceId);
    await createSuppression({ serviceId: a.serviceId, email, scope: "list", listId: "newsletter", reason: "manual" });
    expect((await message(a, d, email, "newsletter")).suppressed).toBe(true);
    expect((await message(a, d, email, "receipts")).suppressed).toBe(false); expect((await message(b, d, email, "newsletter")).suppressed).toBe(false);
    const globalId = await addSuppression({ email, scope: "global", reason: "manual" }, "test");
    await query("UPDATE suppressions SET source=$2 WHERE id=$1", [globalId, tag]);
    expect((await message(b, d, email)).suppressed).toBe(true); expect(await removeSuppression(globalId, b.serviceId)).toBeNull();
    expect(await listSuppressions(b.serviceId, email)).toEqual(expect.arrayContaining([expect.objectContaining({ id: globalId, scope: "global" })]));
  });
});
