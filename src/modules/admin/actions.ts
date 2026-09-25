import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  providerConfigSchema,
  domainNameSchema,
  providerSecretSchema,
  providerWebhookSettingsSchema,
  type ProviderType
} from "@/modules/providers/contracts";
import { loadProviderAccount } from "@/modules/config/provider-account";
import { sealSecret } from "@/modules/config/envelope";
import { resolveCallbackTarget } from "@/modules/callbacks/url-policy";
import { acceptMessage } from "@/modules/core/message/service";
import { choosePolicyTarget } from "@/modules/core/routing/engine";
import { providerRegistry } from "@/modules/providers/registry";
import { createId } from "@/server/ids";
import { hashApiKey } from "@/server/crypto";
import { query, transaction } from "@/server/database";
import { PROVIDER_EVENT_RECEIVED } from "@/server/outbox-events";
import { SERVICE_REQUESTS_PER_MINUTE } from "@/server/service-limits";

const identifierSchema = z.string().trim().min(1).max(160);
const categorySchema = z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, "category must be a stable lowercase key");
const optionalIdentifierSchema = z.preprocess(
  value => typeof value === "string" && value.trim() === "" ? undefined : value,
  identifierSchema.optional(),
);
const optionalEmailSchema = z.preprocess(
  value => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().email().max(320).optional(),
);
const optionalDateTimeSchema = z.preprocess(
  value => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().datetime({ offset: true }).optional(),
);

const senderProfileInputSchema = z.object({
  productId: identifierSchema,
  domainId: identifierSchema,
  name: z.string().trim().min(2).max(120),
  fromName: z.string().trim().min(1).max(120),
  fromLocalPart: z.string().trim().min(1).max(64).regex(/^[^@\s]+$/, "fromLocalPart must not contain whitespace or @"),
  replyTo: optionalEmailSchema,
  category: categorySchema,
}).strict();

const routingTargetSchema = z.object({
  accountId: identifierSchema,
  identityId: identifierSchema,
  priority: z.coerce.number().int().min(0).max(1_000_000).default(100),
  weight: z.coerce.number().int().min(1).max(1_000_000).default(100),
  rateLimit: z.coerce.number().int().min(1).max(1_000_000).default(1_000),
}).strict();

const routingPolicyInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  productId: optionalIdentifierSchema,
  serviceId: optionalIdentifierSchema,
  domainId: identifierSchema,
  category: z.preprocess(value => typeof value === "string" && value.trim() === "" ? undefined : value, categorySchema.optional()),
  priority: z.coerce.number().int().min(0).max(1_000_000).default(100),
  targets: z.array(routingTargetSchema).min(1, "At least one routing target is required").max(20),
}).strict().superRefine((input, context) => {
  const identities = new Set<string>();
  input.targets.forEach((target, index) => {
    if (identities.has(target.identityId)) context.addIssue({
      code: "custom",
      path: ["targets", index, "identityId"],
      message: "An identity can appear only once in a routing policy",
    });
    identities.add(target.identityId);
  });
});

const adminSuppressionInputSchema = z.object({
  email: z.string().trim().email().max(320),
  scope: z.enum(["global", "product", "list"]),
  productId: optionalIdentifierSchema,
  listId: optionalIdentifierSchema,
  reason: z.string().trim().min(1).max(240),
  expiresAt: optionalDateTimeSchema,
}).strict().superRefine((input, context) => {
  if (input.scope === "global" && (input.productId || input.listId)) context.addIssue({
    code: "custom", path: ["scope"], message: "Global suppressions cannot target a product or list",
  });
  if (input.scope === "product" && (!input.productId || input.listId)) context.addIssue({
    code: "custom", path: ["scope"], message: "Product suppressions require a product and cannot target a list",
  });
  if (input.scope === "list" && (!input.productId || !input.listId)) context.addIssue({
    code: "custom", path: ["scope"], message: "List suppressions require both a product and list ID",
  });
});

const inboundRouteInputSchema = z.object({
  webhookEndpointId: identifierSchema,
  domainId: identifierSchema,
  productId: identifierSchema,
  serviceId: optionalIdentifierSchema,
  callbackId: optionalIdentifierSchema,
  localPartPattern: z.string().trim().min(1).max(64).regex(/^[a-z0-9._+*-]+$/i, "localPartPattern may contain letters, numbers, ., _, +, -, and one * wildcard").refine(
    value => (value.match(/\*/g) ?? []).length <= 1,
    "localPartPattern can contain at most one * wildcard",
  ).transform(value => value.toLowerCase()),
}).strict().superRefine((input, context) => {
  if (input.callbackId && !input.serviceId) context.addIssue({
    code: "custom", path: ["serviceId"], message: "A callback endpoint requires a service",
  });
});

const serviceCredentialInputSchema = z.object({
  productId: identifierSchema,
  serviceName: z.string().trim().min(2).max(120),
}).strict();

const callbackEventSchema = z.enum([
  "email.accepted",
  "email.delivered",
  "email.bounced",
  "email.failed",
  "email.suppressed",
  "inbound.received",
]);

const callbackInputSchema = z.object({
  serviceId: identifierSchema,
  name: z.string().trim().min(2).max(120),
  url: z.string().trim().url().max(2_048),
  secret: z.string().min(16).max(512).optional(),
  events: z.array(callbackEventSchema).min(1, "Select at least one callback event").max(6),
}).strict();

const domainInputSchema = z.object({
  domain: domainNameSchema,
  accountIds: z.array(identifierSchema).min(1, "Select at least one provider account").max(20),
}).strict().superRefine((input, context) => {
  const accounts = new Set<string>();
  input.accountIds.forEach((accountId, index) => {
    if (accounts.has(accountId)) context.addIssue({
      code: "custom", path: ["accountIds", index], message: "A provider account can be selected only once",
    });
    accounts.add(accountId);
  });
});

async function audit(actor: string, action: string, type: string, id: string | null, details: Record<string, unknown> = {}) {
  await query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,$2,$3,$4,$5)", [actor, action, type, id, details])
}

export async function createProduct(input: { name: string }, actor: string) {
  const validated = z.object({
    name: z.string().trim().min(2).max(120)
  }).parse(input);
  const id = createId("prd");
  await transaction(async client => {
    await client.query("INSERT INTO products(id,name) VALUES ($1,$2)", [id, validated.name]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'product.create','product',$2,$3)", [actor, id, validated])
  });
  return id
}

export async function toggleProduct(id: string, enabled: boolean, actor: string) {
  await query("UPDATE products SET status=$2,updated_at=now() WHERE id=$1", [id, enabled ? "active" : "suspended"]);
  await audit(actor, "product.toggle", "product", id, { enabled })
}

export async function createProviderAccount(input: {
  type: ProviderType;
  name: string;
  configuration: Record<string, unknown>;
  credentials: Record<string, unknown>;
}, actor: string) {
  if (input.type === "mock") throw new Error("Mock providers are available only to automated tests");
  const name = z.string().trim().min(2).max(120).parse(input.name);
  const config = providerConfigSchema.parse({ ...input.configuration, type: input.type, schemaVersion: 1 });
  const secret = providerSecretSchema.parse({ ...input.credentials, type: input.type });
  const accountId = createId("pa");
  const credential = sealSecret(secret, accountId, 1);
  const endpointId = createId("pwe");
  const opaqueToken = randomBytes(24).toString("base64url");
  const publicConfig = { ...config } as Record<string, unknown>;
  delete publicConfig.type;
  delete publicConfig.schemaVersion;
  await transaction(async client => {
    await client.query("INSERT INTO provider_accounts(id,type,name,public_config) VALUES ($1,$2,$3,$4)", [accountId, input.type, name, publicConfig]);
    await client.query("INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by) VALUES ($1,$2,1,$3,$4,$5,$6)", [createId("pc"), accountId, credential.secretCiphertext, credential.encryptedDek, credential.keyVersion, actor]);
    await client.query("INSERT INTO provider_webhook_endpoints(id,provider_account_id,opaque_token) VALUES ($1,$2,$3)", [endpointId, accountId, opaqueToken]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_account.create','provider_account',$2,$3)", [actor, accountId, {
      type: input.type,
      name,
      configuration: publicConfig
    }])
  });
  return { accountId, webhookPath: `/api/provider-events/${input.type}/${opaqueToken}` }
}

export async function testProviderAccount(id: string, actor: string) {
  const account = await loadProviderAccount(id, { allowNonActive: true });
  let health: { healthy: boolean; details?: Record<string, unknown> };
  try {
    health = await account.module.health.check(account.context)
  } catch (error) {
    health = { healthy: false, details: { error: error instanceof Error ? error.message : "Connection failed" } }
  }
  await query("UPDATE provider_accounts SET status=CASE WHEN status='disabled' THEN 'disabled' WHEN $2 THEN 'active' ELSE 'degraded' END,health=$3,updated_at=now() WHERE id=$1", [id, health.healthy, {
    status: health.healthy ? "healthy" : "unhealthy",
    checkedAt: new Date().toISOString(), ...health.details
  }]);
  await audit(actor, "provider_account.test", "provider_account", id, { healthy: health.healthy });
  return health
}

export async function toggleProvider(id: string, enabled: boolean, actor: string) {
  await query("UPDATE provider_accounts SET status=$2,updated_at=now() WHERE id=$1", [id, enabled ? "degraded" : "disabled"]);
  await audit(actor, "provider_account.toggle", "provider_account", id, { enabled })
}

export async function updateProviderQuota(id: string, quota: Record<string, unknown>, actor: string) {
  const validated = z.object({
    monthlyLimit: z.number().int().nonnegative().optional(),
    dailyLimit: z.number().int().nonnegative().optional()
  }).strict().parse(quota);
  await transaction(async client => {
    await client.query("UPDATE provider_accounts SET quota=$2,updated_at=now() WHERE id=$1", [id, validated]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_account.quota_update','provider_account',$2,$3)", [actor, id, { quota: validated }])
  })
}

export async function rotateProviderCredential(id: string, secretValue: Record<string, unknown>, actor: string) {
  const account = (await query<{ type: ProviderType }>("SELECT type FROM provider_accounts WHERE id=$1", [id])).rows[0];
  if (!account) throw new Error("Provider account not found");
  const secret = providerSecretSchema.parse({ ...secretValue, type: account.type });
  return transaction(async client => {
    const latest = await client.query<{
      credential_version: number
    }>("SELECT credential_version FROM provider_credentials WHERE provider_account_id=$1 ORDER BY credential_version DESC LIMIT 1", [id]);
    const version = (latest.rows[0]?.credential_version ?? 0) + 1;
    const envelope = sealSecret(secret, id, version);
    await client.query("UPDATE provider_credentials SET status='revoked',valid_to=now() WHERE provider_account_id=$1 AND status='active'", [id]);
    await client.query("INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [createId("pc"), id, version, envelope.secretCiphertext, envelope.encryptedDek, envelope.keyVersion, actor]);
    await client.query("UPDATE provider_accounts SET status=CASE WHEN status='disabled' THEN 'disabled' ELSE 'degraded' END,health=$2,updated_at=now() WHERE id=$1", [id, {
      status: "unknown",
      credentialRotatedAt: new Date().toISOString()
    }]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_credential.rotate','provider_account',$2,$3)", [actor, id, { credentialVersion: version, requiresTest: true }]);
    return { version, requiresTest: true }
  })
}

export async function configureProviderWebhook(id: string, settingsValue: Record<string, unknown>, actor: string) {
  return transaction(async client => {
    const current = (await client.query<{
      security_version: number;
      type: ProviderType
    }>(`SELECT e.security_version,a.type
      FROM provider_webhook_endpoints e
      JOIN provider_accounts a ON a.id=e.provider_account_id
      WHERE e.id=$1 FOR UPDATE`, [id])).rows[0];
    if (!current) throw new Error("Webhook endpoint not found");
    const settings = providerWebhookSettingsSchema.parse({ ...settingsValue, type: current.type });
    const version = current.security_version + 1;
    const security = { ...settings } as Record<string, unknown>;
    delete security.type;
    const topic = typeof security.expectedTopicArn === "string" ? security.expectedTopicArn : null;
    const ips = Array.isArray(security.ipAllowlist) ? security.ipAllowlist : [];
    delete security.expectedTopicArn;
    delete security.ipAllowlist;
    const envelope = sealSecret(security, id, version);
    await client.query("UPDATE provider_webhook_endpoints SET security_config_ciphertext=$2,security_encrypted_dek=$3,key_version=$4,security_version=$5,security_configured=true,expected_topic_arn=$6,ip_allowlist=$7,updated_at=now() WHERE id=$1", [id, envelope.secretCiphertext, envelope.encryptedDek, envelope.keyVersion, version, topic, ips]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_webhook_endpoint.rotate_security','provider_webhook_endpoint',$2,$3)", [actor, id, {
      securityVersion: version,
      expectedTopicArn: topic,
      ipAllowlist: ips
    }]);
    return { version, configured: true }
  })
}

export async function toggleWebhookEndpoint(id: string, enabled: boolean, actor: string) {
  await query("UPDATE provider_webhook_endpoints SET status=$2,updated_at=now() WHERE id=$1", [id, enabled ? "active" : "disabled"]);
  await audit(actor, "provider_webhook_endpoint.toggle", "provider_webhook_endpoint", id, { enabled })
}

export async function createDomain(input: {
  domain: string;
  accountIds: string[]
}, actor: string) {
  const validated = domainInputSchema.parse(input);
  const domain = validated.domain;
  const accounts = await Promise.all(validated.accountIds.map(async accountId => {
    const account = await loadProviderAccount(accountId);
    return { accountId, account, identity: account.module.identity }
  }));
  for (const { account } of accounts) {
    if (account.context.config.type === "mailgun" && account.context.config.sendingDomain !== domain) {
      throw new Error(`This Mailgun account sends through ${account.context.config.sendingDomain}. Associate it only with that exact sending domain.`);
    }
  }
  const domainId = createId("sd");
  await query("INSERT INTO sending_domains(id,domain) VALUES ($1,$2)", [domainId, domain]);
  const results = [];
  for (const { accountId, account, identity } of accounts) {
    const identityId = createId("pi");
    if (!identity) {
      await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status,dns_records,last_checked_at) VALUES ($1,$2,$3,'verified','[]',now())", [identityId, domainId, accountId]);
      results.push({ accountId, status: "verified", verification: "provider_dashboard" });
      continue
    }
    try {
      const created = await identity.createIdentity(domain, account.context);
      await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,external_identity_id,status,dns_records,last_checked_at) VALUES ($1,$2,$3,$4,$5,$6,now())", [identityId, domainId, accountId, created.externalIdentityId, created.status, created.dnsRecords]);
      results.push({ accountId, status: created.status })
    } catch {
      await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status,dns_records,last_checked_at) VALUES ($1,$2,$3,'failed','[]',now())", [identityId, domainId, accountId]);
      results.push({ accountId, status: "failed" })
    }
  }
  await audit(actor, "sending_domain.create", "sending_domain", domainId, {
    domain,
    identities: results
  });
  return { domainId, identities: results }
}

export async function toggleDomain(id: string, enabled: boolean, actor: string) {
  await query("UPDATE sending_domains SET status=$2,updated_at=now() WHERE id=$1", [id, enabled ? "active" : "disabled"]);
  await audit(actor, "sending_domain.toggle", "sending_domain", id, { enabled })
}

export async function refreshIdentity(id: string, actor: string) {
  const row = (await query<{
    provider_account_id: string;
    external_identity_id: string | null;
    domain: string;
  }>(`SELECT pi.provider_account_id,pi.external_identity_id,sd.domain
      FROM provider_identities pi JOIN sending_domains sd ON sd.id=pi.sending_domain_id
      WHERE pi.id=$1`, [id])).rows[0];
  if (!row) throw new Error("Provider identity not found");
  const account = await loadProviderAccount(row.provider_account_id);
  if (!account.module.identity) throw new Error("This domain is verified in the provider dashboard and cannot be refreshed by Envoy");
  if (!row.external_identity_id) {
    const result = await account.module.identity.createIdentity(row.domain, account.context);
    await query("UPDATE provider_identities SET external_identity_id=$2,status=$3,dns_records=$4,last_checked_at=now(),updated_at=now() WHERE id=$1", [id, result.externalIdentityId, result.status, result.dnsRecords]);
    await audit(actor, "provider_identity.refresh", "provider_identity", id, { status: result.status });
    return result
  }
  const result = await account.module.identity.checkIdentity(row.external_identity_id, account.context);
  await query("UPDATE provider_identities SET status=$2,dns_records=$3,last_checked_at=now(),updated_at=now() WHERE id=$1", [id, result.status, result.dnsRecords]);
  await audit(actor, "provider_identity.refresh", "provider_identity", id, { status: result.status });
  return result
}

export async function toggleIdentity(id: string, enabled: boolean, actor: string) {
  const identity = (await query<{ type: ProviderType }>(`SELECT pa.type FROM provider_identities pi
    JOIN provider_accounts pa ON pa.id=pi.provider_account_id WHERE pi.id=$1`, [id])).rows[0];
  if (!identity) throw new Error("Provider identity not found");
  await query("UPDATE provider_identities SET status=$2,updated_at=now() WHERE id=$1", [id, enabled ? providerRegistry(identity.type).identity ? "pending" : "verified" : "disabled"]);
  await audit(actor, "provider_identity.toggle", "provider_identity", id, { enabled })
}

export async function createSenderProfile(input: {
  productId: string;
  domainId: string;
  name: string;
  fromName: string;
  fromLocalPart: string;
  replyTo?: string;
  category: string
}, actor: string) {
  const validated = senderProfileInputSchema.parse(input);
  const id = createId("sp");
  await transaction(async client => {
    const product = await client.query<{ id: string }>("SELECT id FROM products WHERE id=$1", [validated.productId]);
    const domain = await client.query<{ id: string; status: string }>("SELECT id,status FROM sending_domains WHERE id=$1", [validated.domainId]);
    const verifiedIdentity = await client.query<{ id: string }>(`SELECT pi.id FROM provider_identities pi
      JOIN provider_accounts pa ON pa.id=pi.provider_account_id
      WHERE pi.sending_domain_id=$1 AND pi.status='verified' AND pa.status='active' LIMIT 1`, [validated.domainId]);
    const existing = await client.query<{ id: string }>("SELECT id FROM sender_profiles WHERE product_id=$1 AND name=$2", [validated.productId, validated.name]);
    if (!product.rows[0]) throw new Error("Product not found");
    if (!domain.rows[0]) throw new Error("Sending domain not found");
    if (domain.rows[0].status !== "active" || !verifiedIdentity.rows[0]) throw new Error("An active sending domain with a verified provider identity is required");
    if (existing.rows[0]) throw new Error("A sender profile with this name already exists for the product");
    await client.query("INSERT INTO sender_profiles(id,product_id,sending_domain_id,name,from_name,from_local_part,reply_to,message_category) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [id, validated.productId, validated.domainId, validated.name, validated.fromName, validated.fromLocalPart, validated.replyTo ?? null, validated.category]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id) VALUES ($1,'sender_profile.create','sender_profile',$2)", [actor, id]);
  });
  return id
}

export async function toggleSenderProfile(id: string, enabled: boolean, actor: string) {
  await query("UPDATE sender_profiles SET status=$2,updated_at=now() WHERE id=$1", [id, enabled ? "active" : "disabled"]);
  await audit(actor, "sender_profile.toggle", "sender_profile", id, { enabled })
}

export async function createRoutingPolicy(input: {
  name: string;
  productId?: string;
  serviceId?: string;
  domainId: string;
  category?: string;
  priority?: number;
  targets: Array<{ accountId: string; identityId: string; priority?: number; weight?: number; rateLimit?: number }>
}, actor: string) {
  const validated = routingPolicyInputSchema.parse(input);
  const id = createId("rp");
  await transaction(async client => {
    let productId = validated.productId;
    if (validated.serviceId) {
      const service = (await client.query<{ product_id: string }>("SELECT product_id FROM services WHERE id=$1", [validated.serviceId])).rows[0];
      if (!service) throw new Error("Service not found");
      if (productId && productId !== service.product_id) throw new Error("The selected service does not belong to the selected product");
      productId = service.product_id;
    }
    if (productId) {
      const product = await client.query<{ id: string }>("SELECT id FROM products WHERE id=$1", [productId]);
      if (!product.rows[0]) throw new Error("Product not found");
    }
    const domain = await client.query<{ id: string; status: string }>("SELECT id,status FROM sending_domains WHERE id=$1", [validated.domainId]);
    if (!domain.rows[0]) throw new Error("Sending domain not found");
    if (domain.rows[0].status !== "active") throw new Error("Routing policies require an active sending domain");
    const identities = await client.query<{ id: string; sending_domain_id: string; provider_account_id: string; status: string; account_status: string }>(`SELECT pi.id,pi.sending_domain_id,pi.provider_account_id,pi.status,pa.status AS account_status
      FROM provider_identities pi JOIN provider_accounts pa ON pa.id=pi.provider_account_id
      WHERE pi.id=ANY($1::text[])`, [validated.targets.map(target => target.identityId)]);
    if (identities.rows.length !== validated.targets.length) throw new Error("One or more provider identities were not found");
    const accountByIdentity = new Map(identities.rows.map(identity => [identity.id, identity.provider_account_id]));
    for (const target of validated.targets) {
      if (accountByIdentity.get(target.identityId) !== target.accountId) throw new Error("Each routing target must use an identity owned by its provider account");
      const identity = identities.rows.find(item => item.id === target.identityId);
      if (identity?.sending_domain_id !== validated.domainId || identity.status !== "verified" || identity.account_status !== "active") throw new Error("Routing targets must be verified identities for the selected sending domain on active provider accounts");
    }
    await client.query("INSERT INTO routing_policies(id,name,product_id,service_id,sending_domain_id,message_category,priority) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id, validated.name, productId ?? null, validated.serviceId ?? null, validated.domainId, validated.category ?? null, validated.priority]);
    for (const target of validated.targets) await client.query("INSERT INTO routing_targets(id,policy_id,provider_account_id,provider_identity_id,priority,weight,rate_limit_per_minute) VALUES ($1,$2,$3,$4,$5,$6,$7)", [createId("rt"), id, target.accountId, target.identityId, target.priority, target.weight, target.rateLimit]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'routing_policy.create','routing_policy',$2,$3)", [actor, id, {
      productId: productId ?? null,
      serviceId: validated.serviceId ?? null,
      domainId: validated.domainId,
      category: validated.category ?? null,
      priority: validated.priority,
      targetCount: validated.targets.length
    }])
  });
  return id
}

export async function toggleRoutingPolicy(id: string, enabled: boolean, actor: string) {
  await query("UPDATE routing_policies SET status=$2,updated_at=now() WHERE id=$1", [id, enabled ? "active" : "disabled"]);
  await audit(actor, "routing_policy.toggle", "routing_policy", id, { enabled })
}

export async function simulateRouting(input: {
  domainId: string;
  productId?: string;
  serviceId?: string;
  category?: string
}) {
  const domainId = identifierSchema.parse(input.domainId);
  type SimulationRow = {
    policy_id: string;
    policy_name: string;
    policy_priority: number;
    target_id: string;
    priority: number;
    weight: number;
    status: string;
    circuit_open_until: Date | null;
    account_id: string;
    account: string;
    type: string;
    account_status: string;
    health: Record<string, unknown>;
    quota: Record<string, unknown>;
    identity_id: string;
    identity_status: string;
    domain: string;
    domain_status: string;
    monthly_usage: string;
    daily_usage: string
  };
  const result = await query<SimulationRow>(`SELECT rp.id AS policy_id,rp.name AS policy_name,rp.priority AS policy_priority,rt.id AS target_id,rt.priority,rt.weight,rt.status,rt.circuit_open_until,
    pa.id AS account_id,pa.name AS account,pa.type,pa.status AS account_status,pa.health,pa.quota,pi.id AS identity_id,pi.status AS identity_status,sd.domain,sd.status AS domain_status,
    usage.monthly_usage::text,usage.daily_usage::text
    FROM routing_policies rp JOIN routing_targets rt ON rt.policy_id=rp.id JOIN provider_accounts pa ON pa.id=rt.provider_account_id
    JOIN provider_identities pi ON pi.id=rt.provider_identity_id AND pi.provider_account_id=pa.id JOIN sending_domains sd ON sd.id=pi.sending_domain_id
    CROSS JOIN LATERAL(SELECT count(*)FILTER(WHERE da.started_at>=date_trunc('month',now())AND da.status IN('submitting','accepted','reconciled'))monthly_usage,count(*)FILTER(WHERE da.started_at>=date_trunc('day',now())AND da.status IN('submitting','accepted','reconciled'))daily_usage FROM delivery_attempts da WHERE da.provider_account_id=pa.id)usage
    WHERE rp.status='active' AND rp.sending_domain_id=$1 AND pi.sending_domain_id=$1 AND ($2::text IS NULL OR rp.product_id IS NULL OR rp.product_id=$2) AND ($3::text IS NULL OR rp.service_id IS NULL OR rp.service_id=$3) AND ($4::text IS NULL OR rp.message_category IS NULL OR rp.message_category=$4) ORDER BY rp.priority,rt.priority,rt.id`, [domainId, input.productId || null, input.serviceId || null, input.category || null]);
  const candidates = result.rows.map(row => {
    const reasons: string[] = [];
    if (row.status === "circuit_open" && (!row.circuit_open_until || row.circuit_open_until > new Date())) reasons.push("circuit_open");
    if (row.account_status !== "active") reasons.push("account_unavailable");
    if (["unhealthy", "offline"].includes(String(row.health.status))) reasons.push("account_unhealthy");
    if (row.identity_status !== "verified") reasons.push("identity_unverified");
    if (row.domain_status !== "active") reasons.push("domain_disabled");
    const monthly = typeof row.quota.monthlyLimit === "number" ? row.quota.monthlyLimit : null;
    const daily = typeof row.quota.dailyLimit === "number" ? row.quota.dailyLimit : null;
    if (monthly !== null && Number(row.monthly_usage) >= monthly) reasons.push("monthly_quota_exhausted");
    if (daily !== null && Number(row.daily_usage) >= daily) reasons.push("daily_quota_exhausted");
    return {
      ...row,
      eligible: reasons.length === 0,
      reasons,
      monthlyUsage: Number(row.monthly_usage),
      dailyUsage: Number(row.daily_usage)
    }
  });
  const eligible = candidates.filter(row => row.eligible).map(row => ({ ...row, policyPriority: row.policy_priority }));
  return { candidates, chosen: choosePolicyTarget(JSON.stringify(input), 1, eligible) ?? null }
}

export async function manualRetryDelivery(id: string, acknowledgeDuplicateRisk: boolean, actor: string) {
  await transaction(async client => {
    const row = (await client.query<{
      lifecycle_status: string;
      current_attempt_id: string | null
    }>("SELECT lifecycle_status,current_attempt_id FROM deliveries WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!row) throw new Error("Delivery not found");
    if (row.lifecycle_status === "unknown" && !acknowledgeDuplicateRisk) throw new Error("Duplicate-risk acknowledgement is required for an unknown outcome");
    if (!["unknown", "failed", "bounced", "deferred"].includes(row.lifecycle_status)) throw new Error("This delivery cannot be retried");
    if (row.current_attempt_id) {
      await client.query("UPDATE delivery_attempts SET routing_snapshot=routing_snapshot||jsonb_build_object('manualRetryAuthorizedAt',now()::text) WHERE id=$1", [row.current_attempt_id]);
      if (row.lifecycle_status === "unknown") await client.query("UPDATE delivery_attempts SET status='failed',outcome_determinate=true,error_category='unknown',error_code='manual_override',error_message='Operator accepted duplicate risk' WHERE id=$1", [row.current_attempt_id])
    }
    await client.query("UPDATE deliveries SET lifecycle_status='queued',updated_at=now() WHERE id=$1", [id]);
    await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'delivery',$2,'delivery.requested',$3)", [createId("out"), id, { deliveryId: id }]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'delivery.manual_retry','delivery',$2,$3)", [actor, id, {
      previousStatus: row.lifecycle_status,
      duplicateRiskAcknowledged: acknowledgeDuplicateRisk
    }])
  })
}

export async function replayRawEvent(id: string, actor: string) {
  await transaction(async client => {
    await client.query("UPDATE raw_provider_events SET processed_at=NULL,processing_error=NULL WHERE id=$1", [id]);
    await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'raw_provider_event',$2,$3,$4)", [createId("out"), id, PROVIDER_EVENT_RECEIVED, { rawEventId: id }]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id) VALUES ($1,'provider_event.replay','raw_provider_event',$2)", [actor, id])
  })
}

export async function addSuppression(input: {
  email: string;
  scope: "global" | "product" | "list";
  productId?: string;
  listId?: string;
  reason: string;
  expiresAt?: string
}, actor: string) {
  const validated = adminSuppressionInputSchema.parse(input);
  if (validated.productId) {
    const product = await query<{ id: string }>("SELECT id FROM products WHERE id=$1", [validated.productId]);
    if (!product.rows[0]) throw new Error("Product not found");
  }
  const id = createId("sup");
  await transaction(async client => {
    await client.query("INSERT INTO suppressions(id,scope_type,product_id,list_id,email_normalized,reason,source,expires_at) VALUES ($1,$2,$3,$4,$5,$6,'admin',$7)", [id, validated.scope, validated.productId ?? null, validated.listId ?? null, validated.email.toLowerCase(), validated.reason, validated.expiresAt ?? null]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'suppression.create','suppression',$2,$3)", [actor, id, { email: validated.email }]);
  });
  return id
}

export async function removeSuppression(id: string, actor: string) {
  await query("UPDATE suppressions SET active=false,updated_at=now() WHERE id=$1", [id]);
  await audit(actor, "suppression.remove", "suppression", id)
}

export async function sendTestMessage(input: {
  serviceId: string;
  recipient: string;
  category: string;
  senderProfile?: string;
  subject: string;
  html?: string;
  text?: string
}, actor: string) {
  const row = (await query<{
    service_id: string;
    service_name: string;
    product_id: string;
    product_name: string
  }>(`SELECT s.id AS service_id,s.name AS service_name,p.id AS product_id,p.name AS product_name
      FROM services s JOIN products p ON p.id=s.product_id
      WHERE s.id=$1 AND p.status='active'`, [input.serviceId])).rows[0];
  if (!row) throw new Error("The selected service is unavailable");
  const result = await acceptMessage({
    identity: {
      serviceId: row.service_id,
      serviceName: row.service_name,
      productId: row.product_id,
      product: row.product_name,
      rateLimitPerMinute: SERVICE_REQUESTS_PER_MINUTE
    },
    idempotencyKey: `admin-test-${crypto.randomUUID()}`,
    input: {
      category: input.category,
      senderProfile: input.senderProfile,
      to: [{ email: input.recipient }],
      subject: input.subject,
      html: input.html,
      text: input.text,
      metadata: { source: "admin_test" }
    }
  });
  await audit(actor, "message.test_send", "message", result.message.id, {
    recipient: input.recipient,
    serviceId: input.serviceId
  });
  return result.message
}

export async function createServiceCredential(input: { productId: string; serviceName: string }, actor: string) {
  const validated = serviceCredentialInputSchema.parse(input);
  return transaction(async client => {
    const product = await client.query<{ id: string }>("SELECT id FROM products WHERE id=$1", [validated.productId]);
    if (!product.rows[0]) throw new Error("Product not found");
    let service = (await client.query<{
      id: string
    }>("SELECT id FROM services WHERE product_id=$1 AND name=$2", [validated.productId, validated.serviceName])).rows[0];
    if (!service) {
      service = { id: createId("svc") };
      await client.query("INSERT INTO services(id,product_id,name) VALUES ($1,$2,$3)", [service.id, validated.productId, validated.serviceName])
    }
    const raw = `ev_live_${randomBytes(24).toString("base64url")}`;
    const id = createId("cred");
    await client.query("INSERT INTO service_credentials(id,service_id,key_prefix,key_hash) VALUES ($1,$2,$3,$4)", [id, service.id, raw.slice(0, 12), hashApiKey(raw)]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id) VALUES ($1,'service_credential.create','service_credential',$2)", [actor, id]);
    return { id, key: raw }
  })
}

export async function rotateServiceCredential(id: string, actor: string) {
  const raw = `ev_live_${randomBytes(24).toString("base64url")}`;
  await query("UPDATE service_credentials SET key_prefix=$2,key_hash=$3,valid_from=now(),status='active' WHERE id=$1", [id, raw.slice(0, 12), hashApiKey(raw)]);
  await audit(actor, "service_credential.rotate", "service_credential", id);
  return { id, key: raw }
}

export async function revokeServiceCredential(id: string, actor: string) {
  await query("UPDATE service_credentials SET status='revoked',valid_to=now() WHERE id=$1", [id]);
  await audit(actor, "service_credential.revoke", "service_credential", id)
}

export async function createCallback(input: {
  serviceId: string;
  name: string;
  url: string;
  secret?: string;
  events: string[]
}, actor: string) {
  const validated = callbackInputSchema.parse(input);
  const target = await resolveCallbackTarget(validated.url);
  const id = createId("cb");
  const secret = validated.secret ?? `ev_cb_${randomBytes(24).toString("base64url")}`;
  const envelope = sealSecret({ secret }, id, 1);
  await transaction(async client => {
    const service = await client.query<{ id: string }>(`SELECT s.id FROM services s
      JOIN products p ON p.id=s.product_id WHERE s.id=$1 AND p.status='active'`, [validated.serviceId]);
    if (!service.rows[0]) throw new Error("An active service is required for a callback endpoint");
    await client.query("INSERT INTO callback_endpoints(id,service_id,name,url,secret_ciphertext,encrypted_dek,key_version,subscribed_events) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [id, validated.serviceId, validated.name, target.url.toString(), envelope.secretCiphertext, envelope.encryptedDek, envelope.keyVersion, validated.events]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'callback_endpoint.create','callback_endpoint',$2,$3)", [actor, id, { events: validated.events }]);
  });
  return { id, secret }
}

export async function toggleCallback(id: string, enabled: boolean, actor: string) {
  await transaction(async client => {
    const endpoint = await client.query("UPDATE callback_endpoints SET status=$2,updated_at=now() WHERE id=$1 RETURNING id", [id, enabled ? "active" : "disabled"]);
    if (!endpoint.rows[0]) throw new Error("Callback endpoint not found");
    if (!enabled) await client.query(`UPDATE callback_deliveries SET status='dead_letter',last_error='Callback endpoint disabled by operator',updated_at=now()
      WHERE endpoint_id=$1 AND status IN ('pending','retrying','delivering')`, [id]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'callback_endpoint.toggle','callback_endpoint',$2,$3)", [actor, id, { enabled }]);
  })
}

export async function rotateCallbackSecret(id: string, requestedSecret: string | undefined, actor: string) {
  const secret = requestedSecret?.trim() || `ev_cb_${randomBytes(24).toString("base64url")}`;
  if (secret.length < 16 || secret.length > 512) throw new Error("Callback signing secret must contain 16 to 512 characters");
  return transaction(async client => {
    const current = (await client.query<{
      secret_version: number
    }>("SELECT secret_version FROM callback_endpoints WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!current) throw new Error("Callback endpoint not found");
    const version = current.secret_version + 1;
    const envelope = sealSecret({ secret }, id, version);
    await client.query("UPDATE callback_endpoints SET secret_ciphertext=$2,encrypted_dek=$3,key_version=$4,secret_version=$5,updated_at=now() WHERE id=$1", [id, envelope.secretCiphertext, envelope.encryptedDek, envelope.keyVersion, version]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'callback_endpoint.rotate_secret','callback_endpoint',$2,$3)", [actor, id, { secretVersion: version }]);
    return { version, secret }
  })
}

export async function replayDeadLetters(actor: string) {
  return transaction(async client => {
    const rows = (await client.query<{
      id: string
    }>(`UPDATE callback_deliveries d SET status='pending',next_attempt_at=now(),updated_at=now()
        FROM callback_endpoints e WHERE d.endpoint_id=e.id AND d.status='dead_letter' AND e.status='active'
        RETURNING d.id`)).rows;
    for (const row of rows) await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'callback',$2,'callback.requested',$3)", [createId("out"), row.id, { callbackDeliveryId: row.id }]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'callback_delivery.replay_dead_letters','callback_delivery',NULL,$2)", [actor, { count: rows.length }]);
    return rows.length
  })
}

export async function testCallback(id: string, actor: string) {
  const deliveryId = createId("cbx");
  const payload = {
    id: createId("event"),
    apiVersion: "2026-09-01",
    type: "endpoint.test",
    occurredAt: new Date().toISOString(),
    data: { message: "Envoy callback endpoint test" }
  };
  await transaction(async client => {
    const endpoint = await client.query<{ id: string }>("SELECT id FROM callback_endpoints WHERE id=$1 AND status='active'", [id]);
    if (!endpoint.rows[0]) throw new Error("An active callback endpoint is required for a test delivery");
    await client.query("INSERT INTO callback_deliveries(id,endpoint_id,event_type,payload) VALUES ($1,$2,'endpoint.test',$3)", [deliveryId, id, payload]);
    await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'callback',$2,'callback.requested',$3)", [createId("out"), deliveryId, { callbackDeliveryId: deliveryId }]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id) VALUES ($1,'callback_endpoint.test','callback_endpoint',$2)", [actor, id]);
  });
  return deliveryId
}

export async function createInboundRoute(input: {
  webhookEndpointId: string;
  domainId: string;
  productId: string;
  serviceId?: string;
  callbackId?: string;
  localPartPattern: string
}, actor: string) {
  const validated = inboundRouteInputSchema.parse(input);
  const id = createId("ir");
  await transaction(async client => {
    const endpoint = (await client.query<{ provider_account_id: string; type: ProviderType; status: string; security_configured: boolean }>(`SELECT e.provider_account_id,a.type,e.status,e.security_configured
      FROM provider_webhook_endpoints e JOIN provider_accounts a ON a.id=e.provider_account_id
      WHERE e.id=$1`, [validated.webhookEndpointId])).rows[0];
    if (!endpoint) throw new Error("Provider webhook endpoint not found");
    if (endpoint.status !== "active") throw new Error("Provider webhook endpoint is disabled");
    if (!endpoint.security_configured) throw new Error("Provider webhook security must be configured before inbound routing");
    if (!providerRegistry(endpoint.type).inbound) throw new Error("This provider does not support inbound routes");

    const domain = await client.query<{ id: string; status: string }>("SELECT id,status FROM sending_domains WHERE id=$1", [validated.domainId]);
    const product = await client.query<{ id: string }>("SELECT id FROM products WHERE id=$1 AND status='active'", [validated.productId]);
    const identity = await client.query<{ id: string }>(`SELECT id FROM provider_identities
      WHERE sending_domain_id=$1 AND provider_account_id=$2 AND status='verified'`, [validated.domainId, endpoint.provider_account_id]);
    if (!domain.rows[0]) throw new Error("Inbound domain not found");
    if (domain.rows[0].status !== "active") throw new Error("Inbound routes require an active sending domain");
    if (!product.rows[0]) throw new Error("Product not found");
    if (!identity.rows[0]) throw new Error("The selected provider endpoint has no usable identity for this domain");

    if (validated.serviceId) {
      const service = (await client.query<{ product_id: string }>("SELECT product_id FROM services WHERE id=$1", [validated.serviceId])).rows[0];
      if (!service) throw new Error("Service not found");
      if (service.product_id !== validated.productId) throw new Error("The selected service does not belong to the selected product");
    }
    if (validated.callbackId) {
      const callback = (await client.query<{ service_id: string; product_id: string; subscribed_events: string[] }>(`SELECT ce.service_id,s.product_id,ce.subscribed_events
        FROM callback_endpoints ce JOIN services s ON s.id=ce.service_id WHERE ce.id=$1 AND ce.status='active'`, [validated.callbackId])).rows[0];
      if (!callback) throw new Error("Callback endpoint not found");
      if (callback.product_id !== validated.productId) throw new Error("The selected callback endpoint does not belong to the selected product");
      if (callback.service_id !== validated.serviceId) throw new Error("The selected callback endpoint does not belong to the selected service");
      if (!callback.subscribed_events.includes("inbound.received")) throw new Error("The selected callback endpoint must subscribe to inbound.received");
    }
    await client.query("INSERT INTO inbound_routes(id,provider_webhook_endpoint_id,sending_domain_id,local_part_pattern,product_id,service_id,callback_endpoint_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id, validated.webhookEndpointId, validated.domainId, validated.localPartPattern, validated.productId, validated.serviceId ?? null, validated.callbackId ?? null]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id) VALUES ($1,'inbound_route.create','inbound_route',$2)", [actor, id]);
  });
  return id
}

export async function toggleInboundRoute(id: string, enabled: boolean, actor: string) {
  await query("UPDATE inbound_routes SET status=$2 WHERE id=$1", [id, enabled ? "active" : "disabled"]);
  await audit(actor, "inbound_route.toggle", "inbound_route", id, { enabled })
}
