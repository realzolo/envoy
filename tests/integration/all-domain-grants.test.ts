vi.mock("@/server/admin-auth", () => ({ getAdminSession: vi.fn().mockResolvedValue({ email: "admin@example.test" }) }));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMessageSchema } from "@/lib/contracts";
import { createDomain } from "@/modules/channels/public";
import { createInboundRoute } from "@/modules/inbound/public";
import { rotateServiceCredential, setDomainGrant, toggleDomainGrant } from "@/modules/identity/public";
import { toggleCallback } from "@/modules/callbacks/public";
import { createService, updateService, ServiceConfigurationConflictError } from "@/modules/identity/public";
import { adminData, dashboardData } from "@/server/admin-queries";
import { acceptMessage, getMessage } from "@/modules/outbound/public";
import { authorizedSendingDomain } from "@/modules/identity/public";
import { discoverMail } from "@/modules/identity/public";
import { getInboundMessage } from "@/modules/inbound/public";
import { persistInbound } from "@/modules/inbound/public";
import { authenticateService, type ServiceIdentity } from "@/server/auth";
import { db, query } from "@/platform/database";
import { prepareSubmission } from "@/modules/outbound/public";
import { getOutboundFile, uploadOutboundFile } from "@/modules/attachments/public";
import { objectStore } from "@/platform/storage/object-store";

const tag = crypto.randomUUID();
const productId = `prd_all_${tag}`;
const domainIds: string[] = [];
const receiptIds: string[] = [];

async function registerDomain() {
  const domain = `all-${crypto.randomUUID()}.test`;
  const { domainId } = await createDomain({ domain, accountIds: [] }, "test");
  domainIds.push(domainId);
  return { domain, domainId };
}

async function issue(allSendingDomains: boolean, allReceivingDomains: boolean) {
  const credential = await createService({
    productId, serviceName: `Service ${crypto.randomUUID()}`, sending: {mode: allSendingDomains ? "all" : "none"}, receiving: {mode: allReceivingDomains ? "all" : "none"},
  }, "test");
  const identity = await authenticateService(new Request("https://envoy.test", {
    headers: { authorization: `Bearer ${credential.key}` },
  }));
  expect(identity).not.toBeNull();
  return { ...credential, identity: identity as ServiceIdentity };
}

async function saveConfiguration(serviceId: string, configuration: unknown, actor: string) {
  const { configuration_revision: revision } = (await query<{configuration_revision:number}>("SELECT configuration_revision FROM services WHERE id=$1", [serviceId])).rows[0];
  return updateService(serviceId, configuration, revision, actor);
}

async function receive(serviceId: string, domain: string, domainId: string) {
  await createInboundRoute({ productId, serviceId, domainId, webhookEndpointId: "pwe_mock" }, "test");
  const externalMessageId = `all-${crypto.randomUUID()}`;
  receiptIds.push(externalMessageId);
  return persistInbound({
    providerAccountId: "pa_mock", webhookEndpointId: "pwe_mock", rawEventId: null!,
    message: {
      externalMessageId, from: "outside@example.net", to: [`help@${domain}`], cc: [], bcc: [],
      envelopeRecipients: [`help@${domain}`], subject: "Future domain", text: "Body", receivedAt: new Date(), attachments: [],
    },
  });
}

beforeAll(async () => {
  await query("INSERT INTO products(id,name) VALUES($1,$1)", [productId]);
});

afterAll(async () => {
  const files = (await query<{object_key:string}>("SELECT f.object_key FROM outbound_files f JOIN services s ON s.id=f.service_id WHERE s.product_id=$1", [productId])).rows;
  for (const file of files) await objectStore().delete(file.object_key);
  await query("DELETE FROM callback_deliveries WHERE endpoint_id IN (SELECT e.id FROM callback_endpoints e JOIN services s ON s.id=e.service_id WHERE s.product_id=$1)", [productId]);
  await query("DELETE FROM messages WHERE product_id=$1", [productId]);
  await query("DELETE FROM outbound_files WHERE service_id IN (SELECT id FROM services WHERE product_id=$1)", [productId]);
  await query("DELETE FROM inbound_messages WHERE product_id=$1", [productId]);
  await query("DELETE FROM inbound_receipts WHERE external_message_id=ANY($1)", [receiptIds]);
  await query("DELETE FROM routing_policies WHERE product_id=$1", [productId]);
  await query("DELETE FROM products WHERE id=$1", [productId]);
  await query("DELETE FROM sending_domains WHERE id=ANY($1)", [domainIds]);
  await db().end();
});

describe("ALL domain grants", () => {
  it("authorizes current and later domains with one persistent grant and retains it across key rotation", async () => {
    const current = await registerDomain();
    const credential = await issue(true, true);
    const future = await registerDomain();
    const grants = (await query("SELECT * FROM service_domain_grants WHERE service_id=$1", [credential.serviceId])).rows;
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ sending_domain_id: null, send_allowed: true, receive_allowed: true });
    for (const domain of [current, future]) {
      expect(await authorizedSendingDomain(credential.serviceId, domain.domain)).toBe(domain.domainId);
      expect((await discoverMail(credential.identity)).domains).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: domain.domainId, permissions: { send: true, receive: true } }),
      ]));
    }
    expect(await authorizedSendingDomain(credential.serviceId, `sub.${future.domain}`)).toBeNull();
    expect(await authorizedSendingDomain(credential.serviceId, "unregistered.example.net")).toBeNull();
    const rotated = await rotateServiceCredential(credential.id, "test");
    const identity = await authenticateService(new Request("https://envoy.test", { headers: { authorization: `Bearer ${rotated.key}` } }));
    expect(identity?.serviceId).toBe(credential.serviceId);
    expect(await authorizedSendingDomain(identity!.serviceId, future.domain)).toBe(future.domainId);
    const admin = await adminData("api-keys");
    expect(admin.grants).toEqual(expect.arrayContaining([
      expect.objectContaining({ service_id: credential.serviceId, domain: "All domains (current and future)" }),
    ]));
  });

  it("keeps sending and receiving ALL independent, including after registration", async () => {
    const sender = await issue(true, false);
    const receiver = await issue(false, true);
    const future = await registerDomain();
    expect(await authorizedSendingDomain(sender.serviceId, future.domain)).toBe(future.domainId);
    expect(await authorizedSendingDomain(receiver.serviceId, future.domain)).toBeNull();
    expect((await discoverMail(sender.identity)).domains.find(domain => domain.id === future.domainId)?.permissions).toEqual({ send: true, receive: false });
    expect((await discoverMail(receiver.identity)).domains.find(domain => domain.id === future.domainId)?.permissions).toEqual({ send: false, receive: true });
    await expect(createInboundRoute({ productId, serviceId: sender.serviceId, domainId: future.domainId, webhookEndpointId: "pwe_mock" }, "test")).rejects.toThrow("receiving permission");
    const id = await receive(receiver.serviceId, future.domain, future.domainId);
    expect(await getInboundMessage(id, receiver.serviceId)).toMatchObject({ envelopeRecipients: [`help@${future.domain}`] });
    expect(await getInboundMessage(id, sender.serviceId)).toBeNull();
  });

  it("uses ALL for actual mail and resource access while enforcing disabled domains and suspended products", async () => {
    const credential = await issue(true, true);
    const future = await registerDomain();
    const providerIdentityId = `pi_${future.domainId}`, policyId = `rp_${future.domainId}`;
    await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status) VALUES($1,$2,'pa_mock','verified')", [providerIdentityId, future.domainId]);
    await query("INSERT INTO routing_policies(id,name,product_id,sending_domain_id) VALUES($1,$1,$2,$3)", [policyId, productId, future.domainId]);
    await query("INSERT INTO routing_targets(id,policy_id,provider_account_id,provider_identity_id) VALUES($1,$2,'pa_mock',$3)", [`rt_${future.domainId}`, policyId, providerIdentityId]);
    const accepted = await acceptMessage({
      identity: credential.identity, idempotencyKey: crypto.randomUUID(),
      input: createMessageSchema.parse({ from: { email: `hello@${future.domain}` }, to: [{ email: "customer@example.net" }], subject: "ALL", text: "Body" }),
    });
    const inboundId = await receive(credential.serviceId, future.domain, future.domainId);
    expect(await getMessage(accepted.message.id, credential.serviceId)).not.toBeNull();
    expect(await getInboundMessage(inboundId, credential.serviceId)).not.toBeNull();
    const dashboard = await dashboardData();
    expect(dashboard.setup.chains).toEqual(expect.arrayContaining([
      expect.objectContaining({ service: credential.identity.serviceName, sender: `*@${future.domain}`, grant: true }),
    ]));
    await query("UPDATE sending_domains SET status='disabled' WHERE id=$1", [future.domainId]);
    try {
      expect(await authorizedSendingDomain(credential.serviceId, future.domain)).toBeNull();
      expect(await getMessage(accepted.message.id, credential.serviceId)).toBeNull();
      expect(await getInboundMessage(inboundId, credential.serviceId)).toBeNull();
    } finally {
      await query("UPDATE sending_domains SET status='active' WHERE id=$1", [future.domainId]);
    }
    await query("UPDATE products SET status='suspended' WHERE id=$1", [productId]);
    try {
      expect(await authorizedSendingDomain(credential.serviceId, future.domain)).toBeNull();
      expect(await getInboundMessage(inboundId, credential.serviceId)).toBeNull();
    } finally {
      await query("UPDATE products SET status='active' WHERE id=$1", [productId]);
    }
  });

  it("updates and revokes ALL without duplicating domains or overriding exact grants", async () => {
    const credential = await issue(true, true);
    const exact = await registerDomain(), future = await registerDomain();
    await setDomainGrant({ serviceId: credential.serviceId, domainId: exact.domainId, send: true, receive: false }, "test");
    const allGrant = await setDomainGrant({ serviceId: credential.serviceId, domainId: null, send: true, receive: true }, "test");
    expect((await query("SELECT id FROM service_domain_grants WHERE service_id=$1 AND sending_domain_id IS NULL", [credential.serviceId])).rows).toHaveLength(1);
    expect((await discoverMail(credential.identity)).domains.filter(domain => domain.id === exact.domainId)).toHaveLength(1);
    const inboundId = await receive(credential.serviceId, future.domain, future.domainId);
    await toggleDomainGrant(allGrant, false, "test");
    expect(await authorizedSendingDomain(credential.serviceId, future.domain)).toBeNull();
    expect(await authorizedSendingDomain(credential.serviceId, exact.domain)).toBe(exact.domainId);
    expect(await getInboundMessage(inboundId, credential.serviceId)).toBeNull();
    const discovered = await discoverMail(credential.identity);
    expect(discovered.domains.find(domain => domain.id === exact.domainId)?.permissions).toEqual({ send: true, receive: false });
    expect(discovered.domains.find(domain => domain.id === future.domainId)).toBeUndefined();
    await toggleDomainGrant(allGrant, true, "test");
    expect(await getInboundMessage(inboundId, credential.serviceId)).not.toBeNull();
    await setDomainGrant({ serviceId: credential.serviceId, domainId: null, send: true, receive: false }, "test");
    expect(await getInboundMessage(inboundId, credential.serviceId)).toBeNull();
  });

  it("accepts ALL for one direction with selected domains for the other and allows a service with no mail permissions", async () => {
    const exact = await registerDomain();
    const credential = await createService({
      productId, serviceName: `Mixed ${crypto.randomUUID()}`, sending: {mode: "all"}, receiving: {mode: "selected", domainIds: [exact.domainId]},
    }, "test");
    const future = await registerDomain();
    expect(await authorizedSendingDomain(credential.serviceId, future.domain)).toBe(future.domainId);
    await receive(credential.serviceId, exact.domain, exact.domainId);
    await expect(createInboundRoute({ productId, serviceId: credential.serviceId, domainId: future.domainId, webhookEndpointId: "pwe_mock" }, "test")).rejects.toThrow("receiving permission");
    const empty = await issue(false, false);
    expect(await authorizedSendingDomain(empty.serviceId, exact.domain)).toBeNull();
    expect((await discoverMail(empty.identity)).domains).toEqual([]);
  });

  it("replaces ALL and historical grants with selected or no permission for every key and queued resource", async () => {
    const credential = await issue(true, true);
    const selected = await registerDomain(), removed = await registerDomain();
    await setDomainGrant({ serviceId: credential.serviceId, domainId: removed.domainId, send: true, receive: true }, "test");
    const pi = `pi_${removed.domainId}`, rp = `rp_${removed.domainId}`;
    await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status) VALUES($1,$2,'pa_mock','verified')", [pi, removed.domainId]);
    await query("INSERT INTO routing_policies(id,name,product_id,sending_domain_id) VALUES($1,$1,$2,$3)", [rp, productId, removed.domainId]);
    await query("INSERT INTO routing_targets(id,policy_id,provider_account_id,provider_identity_id) VALUES($1,$2,'pa_mock',$3)", [`rt_${removed.domainId}`, rp, pi]);
    const message = (await acceptMessage({ identity: credential.identity, idempotencyKey: crypto.randomUUID(), input: createMessageSchema.parse({ from: { email: `hello@${removed.domain}` }, to: [{ email: "customer@example.net" }], subject: "Queued before narrowing", text: "Body" }) })).message.id;
    const submission = (await query<{id:string}>("SELECT id FROM submissions WHERE message_id=$1", [message])).rows[0].id;
    const file = await uploadOutboundFile(credential.serviceId, "private.txt", "text/plain", Buffer.from("private"), removed.domain);
    const inbound = await receive(credential.serviceId, removed.domain, removed.domainId);
    const replacement = await rotateServiceCredential(credential.id, "test");
    const configuration = { productId, serviceName: "Narrowed service", sending: { mode: "selected", domainIds: [selected.domainId] }, receiving: { mode: "none" }, suppressionManagement: true };
    await saveConfiguration(credential.serviceId, configuration, "test");
    for (const key of [credential.key, replacement.key]) {
      const identity = await authenticateService(new Request("https://envoy.test", { headers: { authorization: `Bearer ${key}` } }));
      expect(identity).toMatchObject({ serviceId: credential.serviceId, serviceName: "Narrowed service", suppressionManagement: true });
      expect(await authorizedSendingDomain(identity!.serviceId, selected.domain)).toBe(selected.domainId);
      expect(await authorizedSendingDomain(identity!.serviceId, removed.domain)).toBeNull();
    }
    expect(await getMessage(message, credential.serviceId)).toBeNull();
    expect(await getOutboundFile(file.id, credential.serviceId)).toBeNull();
    expect(await getInboundMessage(inbound, credential.serviceId)).toBeNull();
    expect(await prepareSubmission(submission)).toBeNull();
    const future = await registerDomain();
    expect(await authorizedSendingDomain(credential.serviceId, future.domain)).toBeNull();
    expect((await query("SELECT sending_domain_id,send_allowed,receive_allowed FROM service_domain_grants WHERE service_id=$1 AND status='active'", [credential.serviceId])).rows).toEqual([{ sending_domain_id: selected.domainId, send_allowed: true, receive_allowed: false }]);
    await saveConfiguration(credential.serviceId, { ...configuration, sending: { mode: "none" } }, "test");
    expect(await authorizedSendingDomain(credential.serviceId, selected.domain)).toBeNull();
    expect((await query("SELECT id FROM service_domain_grants WHERE service_id=$1 AND status='active'", [credential.serviceId])).rows).toEqual([]);
  });

  it("keeps explicit selections fixed and rolls back invalid updates without crossing service or product boundaries", async () => {
    const selected = await registerDomain();
    const configuration = { productId, serviceName: `Selected ${crypto.randomUUID()}`, sending: { mode: "selected", domainIds: [selected.domainId] }, receiving: { mode: "none" } };
    const credential = await createService(configuration, "test");
    const future = await registerDomain(), other = await issue(false, false);
    expect(await authorizedSendingDomain(credential.serviceId, future.domain)).toBeNull();
    expect(await authorizedSendingDomain(other.serviceId, selected.domain)).toBeNull();
    await expect(saveConfiguration(credential.serviceId, { ...configuration, serviceName: "Must roll back", sending: { mode: "selected", domainIds: ["missing"] } }, "test")).rejects.toThrow("registered");
    expect((await query("SELECT name FROM services WHERE id=$1", [credential.serviceId])).rows[0].name).toBe(configuration.serviceName);
    expect(await authorizedSendingDomain(credential.serviceId, selected.domain)).toBe(selected.domainId);
    await expect(saveConfiguration(credential.serviceId, { ...configuration, productId: "prd_atlas" }, "test")).rejects.toThrow("selected product");
    await expect(saveConfiguration(credential.serviceId, { ...configuration, sending: { mode: "all", domainIds: [selected.domainId] } }, "test")).rejects.toThrow("Only selected-domain mode");
    await expect(saveConfiguration(credential.serviceId, { ...configuration, sending: { mode: "selected", domainIds: [] } }, "test")).rejects.toThrow("Select at least one");
  });

  it("rejects a concurrent stale configuration rather than restoring permissions", async () => {
    const service = await issue(true, true);
    const configuration = { productId, serviceName: "Concurrent change", sending: { mode: "none" }, receiving: { mode: "none" } };
    const results = await Promise.allSettled([
      updateService(service.serviceId, configuration, 1, "test"),
      updateService(service.serviceId, { ...configuration, sending: { mode: "all" } }, 1, "test"),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ServiceConfigurationConflictError);
    expect((await query("SELECT configuration_revision FROM services WHERE id=$1", [service.serviceId])).rows[0].configuration_revision).toBe(2);
    expect((await query("SELECT id FROM audit_logs WHERE resource_id=$1 AND action='service.update'", [service.serviceId])).rowCount).toBe(1);
  });

  it("saves callback and advanced settings on the service, retains paused state, audits changes and notifies permission changes", async () => {
    vi.stubEnv("ENVOY_ALLOW_PRIVATE_CALLBACKS", "true");
    try {
      const configuration = { productId, serviceName: `Callback ${crypto.randomUUID()}`, sending: { mode: "all" }, receiving: { mode: "none" }, callbackUrl: "http://127.0.0.1:6179/events", suppressionManagement: true };
      const service = await createService(configuration, "test");
      expect(service.callback?.secret).toBeTruthy();
      await saveConfiguration(service.serviceId, { ...configuration, receiving: { mode: "all" } }, "test");
      const event = (await query("SELECT id,payload FROM callback_deliveries WHERE endpoint_id=$1 AND event_type='service.permissions_changed'", [service.callback!.id])).rows[0];
      expect(event.payload.data).toEqual({ serviceId: service.serviceId, productId });
      expect((await query("SELECT id FROM outbox_events WHERE payload->>'callbackDeliveryId'=$1", [event.id])).rowCount).toBe(1);
      const listed = (await adminData("api-keys")).services!.find(item => item.id === service.serviceId)!;
      expect(listed).toMatchObject({ name: configuration.serviceName, callback_url: configuration.callbackUrl, callback_status: "active", suppression_management_allowed: true, configuration_revision: 2, domain_grants: expect.arrayContaining([expect.objectContaining({ sending_domain_id: null, send_allowed: true, receive_allowed: true, status: "active" })]) });
      await toggleCallback(service.callback!.id, false, "test");
      await saveConfiguration(service.serviceId, configuration, "test");
      expect((await query("SELECT status FROM callback_endpoints WHERE id=$1", [service.callback!.id])).rows[0].status).toBe("disabled");
      await saveConfiguration(service.serviceId, { ...configuration, callbackUrl: "", suppressionManagement: false }, "test");
      expect((await query("SELECT url,status FROM callback_endpoints WHERE id=$1", [service.callback!.id])).rows[0]).toEqual({ url: null, status: "disabled" });
      await expect(toggleCallback(service.callback!.id, true, "test")).rejects.toThrow("Event callback URL");
      const identity = await authenticateService(new Request("https://envoy.test", { headers: { authorization: `Bearer ${service.key}` } }));
      expect((await discoverMail(identity!)).domains.every(domain => domain.notification.mode === "polling")).toBe(true);
      expect((await adminData("webhooks")).callbacks!.some(callback => callback.id === service.callback!.id)).toBe(false);
      const audit = (await query("SELECT details FROM audit_logs WHERE action='service.update' AND resource_id=$1 ORDER BY id DESC", [service.serviceId])).rows;
      expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ details: expect.objectContaining({ appliesTo: "all_service_credentials", configuration: expect.objectContaining({ callbackUrl: "", suppressionManagement: false }) }) })]));
    } finally { vi.unstubAllEnvs(); }
  });
});
