import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMessageSchema } from "@/lib/contracts";
import { createDomain, createInboundRoute, createServiceCredential, rotateServiceCredential, setDomainGrant, toggleDomainGrant } from "@/modules/admin/actions";
import { adminData, dashboardData } from "@/modules/admin/queries";
import { acceptMessage, getMessage } from "@/modules/core/message/service";
import { authorizedSendingDomain } from "@/modules/core/resources/authorization";
import { discoverMail } from "@/modules/core/resources/capabilities";
import { getInboundMessage } from "@/modules/core/resources/service";
import { persistInbound } from "@/modules/inbound/service";
import { authenticateService, type ServiceIdentity } from "@/server/auth";
import { db, query } from "@/server/database";

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
  const credential = await createServiceCredential({
    productId, serviceName: `Service ${crypto.randomUUID()}`, allSendingDomains, allReceivingDomains,
  }, "test");
  const identity = await authenticateService(new Request("https://envoy.test", {
    headers: { authorization: `Bearer ${credential.key}` },
  }));
  expect(identity).not.toBeNull();
  return { ...credential, identity: identity as ServiceIdentity };
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
  await query("DELETE FROM messages WHERE product_id=$1", [productId]);
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
      expect.objectContaining({ service_id: credential.serviceId, domain: "ALL (current and future domains)" }),
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
    expect(discovered.domains.find(domain => domain.id === future.domainId)).toMatchObject({ authorization: "revoked", permissions: { send: false, receive: false } });
    await toggleDomainGrant(allGrant, true, "test");
    expect(await getInboundMessage(inboundId, credential.serviceId)).not.toBeNull();
    await setDomainGrant({ serviceId: credential.serviceId, domainId: null, send: true, receive: false }, "test");
    expect(await getInboundMessage(inboundId, credential.serviceId)).toBeNull();
  });

  it("accepts ALL for one direction with exact domains for the other and still requires a permission", async () => {
    const exact = await registerDomain();
    const credential = await createServiceCredential({
      productId, serviceName: `Mixed ${crypto.randomUUID()}`, allSendingDomains: true,
      domains: [{ domainId: exact.domainId, send: false, receive: true }],
    }, "test");
    const future = await registerDomain();
    expect(await authorizedSendingDomain(credential.serviceId, future.domain)).toBe(future.domainId);
    await receive(credential.serviceId, exact.domain, exact.domainId);
    await expect(createInboundRoute({ productId, serviceId: credential.serviceId, domainId: future.domainId, webhookEndpointId: "pwe_mock" }, "test")).rejects.toThrow("receiving permission");
    await expect(createServiceCredential({ productId, serviceName: `Empty ${crypto.randomUUID()}` }, "test")).rejects.toThrow("Select at least one");
  });
});
