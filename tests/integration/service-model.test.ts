import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMessageSchema } from "@/lib/contracts";
import { createDomain, setDomainInboundProvider, toggleDomain } from "@/modules/channels/public";
import { createService, discoverMail, issueServiceCredential, rotateServiceCredential, toggleService, updateService, type ServiceIdentity } from "@/modules/identity/public";
import { acceptMessage, getMessage, prepareSubmission } from "@/modules/outbound/public";
import { addSuppression, createSuppression, listSuppressions, removeSuppression } from "@/modules/suppressions/public";
import { authenticateService } from "@/server/auth";
import { sealSecret } from "@/platform/crypto/envelope";
import { db, query } from "@/platform/database";

const tag = crypto.randomUUID();
const serviceIds: string[] = [];
const domainIds: string[] = [];
const accountIds: string[] = [];
let a: Awaited<ReturnType<typeof service>>;
let b: Awaited<ReturnType<typeof service>>;
let c: Awaited<ReturnType<typeof service>>;
const configuration = (name: string, domains: Array<{ domainId: string; receive: boolean; outboundIdentityId: string | null }> = []) => ({ serviceName: name, domains });
const authenticate = (key: string) => authenticateService(new Request("https://envoy.test", { headers: { authorization: `Bearer ${key}` } }));

async function service() {
  const credential = await createService(configuration(`Service ${crypto.randomUUID()}`), "test");
  serviceIds.push(credential.serviceId);
  return { ...credential, identity: (await authenticate(credential.key)) as ServiceIdentity };
}
async function domain() {
  const name = `service-${crypto.randomUUID()}.test`;
  const { domainId } = await createDomain({ domain: name, accountIds: [] }, "test");
  domainIds.push(domainId);
  const identityId = `pi_${domainId}`;
  await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status) VALUES($1,$2,'pa_mock','verified')", [identityId, domainId]);
  return { domainId, identityId, name };
}
async function bind(owner: typeof a, domainId: string, outboundIdentityId: string | null) {
  const revision = (await query<{ configuration_revision: number }>("SELECT configuration_revision FROM services WHERE id=$1", [owner.serviceId])).rows[0].configuration_revision;
  return updateService(owner.serviceId, configuration(owner.identity.serviceName, [{ domainId, receive: false, outboundIdentityId }]), revision, "test");
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
  await query("DELETE FROM messages WHERE service_id=ANY($1)", [serviceIds]);
  await query("DELETE FROM suppressions WHERE source=$1 OR service_id=ANY($2)", [tag, serviceIds]);
  await query("DELETE FROM services WHERE id=ANY($1)", [serviceIds]);
  await query("DELETE FROM sending_domains WHERE id=ANY($1)", [domainIds]);
  await query("DELETE FROM provider_accounts WHERE id=ANY($1)", [accountIds]);
  await db().end();
});

describe("Service domain bindings", () => {
  it("creates with no mail permissions and enforces a globally unique name without orphan keys", async () => {
    const name = `Empty ${crypto.randomUUID()}`;
    const config = configuration(name);
    const created = await createService(config, "test");
    serviceIds.push(created.serviceId);
    expect(await authenticate(created.key)).toMatchObject({ serviceId: created.serviceId, serviceName: name });
    expect((await discoverMail((await authenticate(created.key))!)).domains).toEqual([]);
    await expect(createService({ ...config, serviceName: name.toUpperCase() }, "test")).rejects.toThrow();
    expect((await query("SELECT id FROM services WHERE lower(name)=lower($1)", [name])).rowCount).toBe(1);
    expect((await query("SELECT id FROM service_credentials WHERE service_id=$1", [created.serviceId])).rowCount).toBe(1);
  });

  it("keeps receiving permission editable while the inbound provider is unconfigured", async () => {
    const d = await domain();
    const owner = await service();
    const updatedName = `Renamed ${crypto.randomUUID()}`;
    const receiveBinding = [{ domainId: d.domainId, receive: true, outboundIdentityId: null }];
    let revision = (await query<{ configuration_revision: number }>("SELECT configuration_revision FROM services WHERE id=$1", [owner.serviceId])).rows[0].configuration_revision;

    await updateService(owner.serviceId, configuration(owner.identity.serviceName, receiveBinding), revision, "test");
    let capability = (await discoverMail(owner.identity)).domains.find(item => item.id === d.domainId);
    expect(capability?.permissions.receive).toBe(true);
    expect(capability?.receiving).toMatchObject({ state: "unavailable", reasonCodes: ["INBOUND_INGRESS_UNAVAILABLE"] });

    revision++;
    await updateService(owner.serviceId, configuration(updatedName, receiveBinding), revision, "test");
    expect((await query<{ name: string }>("SELECT name FROM services WHERE id=$1", [owner.serviceId])).rows[0].name).toBe(updatedName);

    revision++;
    await updateService(owner.serviceId, configuration(updatedName), revision, "test");
    capability = (await discoverMail(owner.identity)).domains.find(item => item.id === d.domainId);
    expect(capability).toBeUndefined();
  });

  it("keeps send bindings editable while domain or identity is unavailable", async () => {
    const d = await domain();
    const owner = await service();
    await query("UPDATE sending_domains SET status='disabled' WHERE id=$1", [d.domainId]);
    await query("UPDATE provider_identities SET status='pending' WHERE id=$1", [d.identityId]);
    let revision = (await query<{ configuration_revision: number }>("SELECT configuration_revision FROM services WHERE id=$1", [owner.serviceId])).rows[0].configuration_revision;
    const sendBinding = [{ domainId: d.domainId, receive: false, outboundIdentityId: d.identityId }];

    await updateService(owner.serviceId, configuration(owner.identity.serviceName, sendBinding), revision, "test");
    const capability = (await discoverMail(owner.identity)).domains.find(item => item.id === d.domainId);
    expect(capability?.permissions.send).toBe(true);
    expect(capability?.sending).toMatchObject({ state: "unavailable" });
    expect(capability?.sending.reasonCodes).toContain("SENDING_DOMAIN_DISABLED");
    expect(capability?.sending.reasonCodes).toContain("PROVIDER_UNAVAILABLE");

    revision++;
    await updateService(owner.serviceId, configuration(`Pending ${crypto.randomUUID()}`, sendBinding), revision, "test");
    expect((await query("SELECT outbound_provider_identity_id FROM service_domain_bindings WHERE service_id=$1 AND sending_domain_id=$2", [owner.serviceId, d.domainId])).rows[0].outbound_provider_identity_id).toBe(d.identityId);
  });

  it("does not change an existing domain ingress through repeated registration", async () => {
    const name = `registration-${crypto.randomUUID()}.test`;
    const created = await createDomain({ domain: name, accountIds: [], inboundProviderAccountId: "pa_mock" }, "test");
    domainIds.push(created.domainId);
    await expect(createDomain({ domain: name, accountIds: [], inboundProviderAccountId: null }, "test"))
      .rejects.toThrow(/already registered/);
    expect((await query<{ inbound_provider_account_id: string | null }>("SELECT inbound_provider_account_id FROM sending_domains WHERE id=$1", [created.domainId])).rows[0].inbound_provider_account_id).toBe("pa_mock");
    const addProvider = await createDomain({ domain: name, accountIds: ["pa_mock"] }, "test");
    expect(addProvider.domainId).toBe(created.domainId);
    expect((await query("SELECT id FROM provider_identities WHERE sending_domain_id=$1 AND provider_account_id='pa_mock'", [created.domainId])).rowCount).toBe(1);
  });

  it("keeps concurrent registrations of one domain atomic", async () => {
    const name = `concurrent-${crypto.randomUUID()}.test`;
    const results = await Promise.allSettled([
      createDomain({ domain: name, accountIds: [], inboundProviderAccountId: "pa_mock" }, "test"),
      createDomain({ domain: name, accountIds: [], inboundProviderAccountId: null }, "test"),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const [row] = (await query<{ id: string; inbound_provider_account_id: string | null }>("SELECT id,inbound_provider_account_id FROM sending_domains WHERE domain=$1", [name])).rows;
    expect(row).toBeDefined();
    domainIds.push(row.id);
    expect(row.inbound_provider_account_id).toBe(results[0].status === "fulfilled" ? "pa_mock" : null);
  });

  it("revises and notifies only affected Services when domain settings change", async () => {
    const d = await domain();
    const receiver = await service();
    const sender = await service();
    await bind(receiver, d.domainId, d.identityId);
    await bind(sender, d.domainId, d.identityId);
    const receiverRevision = (await query<{ configuration_revision: number }>("SELECT configuration_revision FROM services WHERE id=$1", [receiver.serviceId])).rows[0].configuration_revision;
    const receiverBinding = [{ domainId: d.domainId, receive: true, outboundIdentityId: d.identityId }];
    await updateService(receiver.serviceId, configuration(receiver.identity.serviceName, receiverBinding), receiverRevision, "test");
    for (const owner of [receiver, sender]) {
      const callbackId = `cb_${crypto.randomUUID()}`;
      const secret = sealSecret({ secret: "test-callback-secret" }, callbackId, 1);
      await query("INSERT INTO callback_endpoints(id,service_id,name,url,secret_ciphertext,encrypted_dek,key_version,subscribed_events) VALUES($1,$2,$3,'https://callback.test/events',$4,$5,$6,$7)",
        [callbackId, owner.serviceId, owner.identity.serviceName, secret.secretCiphertext, secret.encryptedDek, secret.keyVersion, ["service.permissions_changed"]]);
    }
    const state = async (serviceId: string) => {
      const revision = (await query<{ configuration_revision: number }>("SELECT configuration_revision FROM services WHERE id=$1", [serviceId])).rows[0].configuration_revision;
      const events = (await query<{ count: number }>("SELECT count(*)::int FROM callback_deliveries c JOIN callback_endpoints e ON e.id=c.endpoint_id WHERE e.service_id=$1 AND c.event_type='service.permissions_changed'", [serviceId])).rows[0].count;
      return { revision, events };
    };
    const beforeReceiver = await state(receiver.serviceId);
    const beforeSender = await state(sender.serviceId);

    await setDomainInboundProvider(d.domainId, "pa_mock", "test");
    expect(await state(receiver.serviceId)).toEqual({ revision: beforeReceiver.revision + 1, events: 1 });
    expect(await state(sender.serviceId)).toEqual(beforeSender);
    await expect(updateService(receiver.serviceId, configuration(receiver.identity.serviceName, receiverBinding), beforeReceiver.revision, "test"))
      .rejects.toThrow("changed");
    await setDomainInboundProvider(d.domainId, "pa_mock", "test");
    expect(await state(receiver.serviceId)).toEqual({ revision: beforeReceiver.revision + 1, events: 1 });

    await toggleDomain(d.domainId, false, "test");
    expect(await state(receiver.serviceId)).toEqual({ revision: beforeReceiver.revision + 2, events: 2 });
    expect(await state(sender.serviceId)).toEqual({ revision: beforeSender.revision + 1, events: 1 });
    await toggleDomain(d.domainId, false, "test");
    expect(await state(sender.serviceId)).toEqual({ revision: beforeSender.revision + 1, events: 1 });
  });

  it("binds the same domain to multiple services, each with its own outbound provider", async () => {
    const d = await domain();
    const secondAccountId = `pa_${crypto.randomUUID().replaceAll("-", "")}`;
    accountIds.push(secondAccountId);
    await query("INSERT INTO provider_accounts(id,type,name,status,public_config,health,quota) VALUES ($1,'mock',$2,'active',$3,$4,$5)", [secondAccountId, `Second provider ${tag}`, { behavior: "deliver" }, { status: "healthy" }, { monthlyLimit: 100000 }]);
    const credential = sealSecret({ type: "mock", token: "test-provider-token" }, secondAccountId, 1);
    await query("INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by) VALUES ($1,$2,1,$3,$4,$5,'test')", [`pc_${secondAccountId}`, secondAccountId, credential.secretCiphertext, credential.encryptedDek, credential.keyVersion]);
    const secondIdentityId = `pi_${secondAccountId}`;
    await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status) VALUES($1,$2,$3,'verified')", [secondIdentityId, d.domainId, secondAccountId]);
    await bind(a, d.domainId, d.identityId);
    await bind(b, d.domainId, secondIdentityId);
    expect((await query<{ service_id: string }>("SELECT service_id FROM service_domain_bindings WHERE sending_domain_id=$1 ORDER BY service_id", [d.domainId])).rows.map(row => row.service_id).sort()).toEqual([a.serviceId, b.serviceId].sort());
    for (const [owner, accountId, identityId] of [[a, "pa_mock", d.identityId], [b, secondAccountId, secondIdentityId]] as const) {
      expect((await discoverMail(owner.identity)).domains.find(item => item.id === d.domainId)?.sending.state).toBe("configured");
      const accepted = await message(owner, d);
      const submissionId = (await query<{ id: string }>("SELECT id FROM submissions WHERE message_id=$1", [accepted.id])).rows[0].id;
      expect(await prepareSubmission(submissionId)).toMatchObject({ providerAccountId: accountId, providerIdentityId: identityId });
    }
    expect((await discoverMail(c.identity)).domains.find(item => item.id === d.domainId)).toBeUndefined();
    await expect(message(c, d)).rejects.toMatchObject({ code: "SENDER_NOT_AUTHORIZED" });
    const otherDomain = await domain();
    const revision = (await query<{ configuration_revision: number }>("SELECT configuration_revision FROM services WHERE id=$1", [a.serviceId])).rows[0].configuration_revision;
    await expect(updateService(a.serviceId, configuration(a.identity.serviceName, [{ domainId: d.domainId, receive: false, outboundIdentityId: otherDomain.identityId }]), revision, "test")).rejects.toThrow(/selected domain/);
    expect((await query<{ outbound_provider_identity_id: string }>("SELECT outbound_provider_identity_id FROM service_domain_bindings WHERE service_id=$1 AND sending_domain_id=$2", [a.serviceId, d.domainId])).rows[0].outbound_provider_identity_id).toBe(d.identityId);
  });

  it("pauses every key and queued dispatch for one service, then resumes its binding", async () => {
    const d = await domain();
    await bind(a, d.domainId, d.identityId);
    const queued = await message(a, d);
    const submission = (await query<{ id: string }>("SELECT id FROM submissions WHERE message_id=$1", [queued.id])).rows[0].id;
    const key = await issueServiceCredential(a.serviceId, "test");
    const revision = (await query<{ configuration_revision: number }>("SELECT configuration_revision FROM services WHERE id=$1", [a.serviceId])).rows[0].configuration_revision;
    await toggleService(a.serviceId, false, "test");
    expect(await authenticate(a.key)).toBeNull();
    expect(await authenticate(key.key)).toBeNull();
    expect(await authenticate(b.key)).not.toBeNull();
    expect(await getMessage(queued.id, a.serviceId)).toBeNull();
    await expect(issueServiceCredential(a.serviceId, "test")).rejects.toThrow("Active service");
    await expect(rotateServiceCredential(key.id, "test")).rejects.toThrow("Active service");
    await expect(updateService(a.serviceId, configuration(a.identity.serviceName, [{ domainId: d.domainId, receive: false, outboundIdentityId: d.identityId }]), revision, "test")).rejects.toThrow("changed");
    expect(await prepareSubmission(submission)).toBeNull();
    await toggleService(a.serviceId, true, "test");
    expect(await authenticate(a.key)).toMatchObject({ serviceId: a.serviceId });
    expect(await getMessage(queued.id, a.serviceId)).not.toBeNull();
    expect((await query("SELECT configuration_revision FROM services WHERE id=$1", [a.serviceId])).rows[0].configuration_revision).toBe(revision + 2);
  });

  it("isolates recipient and list suppressions by service while global rules affect all services", async () => {
    const d = await domain();
    await bind(a, d.domainId, d.identityId);
    await bind(b, d.domainId, d.identityId);
    const email = `isolation-${tag}@example.net`;
    const rule = await createSuppression({ serviceId: a.serviceId, email, scope: "service", reason: "manual" });
    expect((await message(a, d, email)).suppressed).toBe(true);
    expect((await message(b, d, email)).suppressed).toBe(false);
    expect(await removeSuppression(rule.id, b.serviceId)).toBeNull();
    await removeSuppression(rule.id, a.serviceId);
    await createSuppression({ serviceId: a.serviceId, email, scope: "list", listId: "newsletter", reason: "manual" });
    expect((await message(a, d, email, "newsletter")).suppressed).toBe(true);
    expect((await message(a, d, email, "receipts")).suppressed).toBe(false);
    expect((await message(b, d, email, "newsletter")).suppressed).toBe(false);
    const globalId = await addSuppression({ email, scope: "global", reason: "manual" }, "test");
    await query("UPDATE suppressions SET source=$2 WHERE id=$1", [globalId, tag]);
    expect((await message(b, d, email)).suppressed).toBe(true);
    expect(await removeSuppression(globalId, b.serviceId)).toBeNull();
    expect(await listSuppressions(b.serviceId, email)).toEqual(expect.arrayContaining([expect.objectContaining({ id: globalId, scope: "global" })]));
  });
});
