import { randomBytes } from "node:crypto";
import { createMessageSchema, type CreateMessageInput } from "@/lib/contracts";
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
import { choosePolicyTarget, evaluateCandidate, retryDelivery } from "@/modules/core/routing/engine";
import { providerRegistry } from "@/modules/providers/registry";
import { createId } from "@/server/ids";
import { hashApiKey } from "@/server/crypto";
import { query, transaction } from "@/server/database";
import { PROVIDER_EVENT_RECEIVED } from "@/server/outbox-events";
import { queueForEvent } from "@/server/services/outbox";
import { SERVICE_REQUESTS_PER_MINUTE } from "@/server/service-limits";
import { domainPermission } from "@/modules/core/resources/authorization";
import { queuePermissionsChanged } from "./permission-notifications";

const identifierSchema = z.string().trim().min(1).max(160);
const categorySchema = z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, "category must be a stable lowercase key");
const optionalIdentifierSchema = z.preprocess(
  value => typeof value === "string" && value.trim() === "" ? undefined : value,
  identifierSchema.optional(),
);
const optionalDateTimeSchema = z.preprocess(
  value => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().datetime({ offset: true }).optional(),
);

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

const inboundRouteInputSchema=z.object({webhookEndpointId:identifierSchema,domainId:identifierSchema,productId:identifierSchema,serviceId:identifierSchema}).strict();
const domainGrantInputSchema=z.object({serviceId:identifierSchema,domainId:identifierSchema.nullable(),send:z.boolean(),receive:z.boolean()}).strict().refine(v=>v.send||v.receive,{message:"Select sending or receiving"});

const callbackEventSchema = z.enum([
  "email.accepted",
  "email.delivered",
  "email.bounced",
  "email.failed",
  "email.suppressed",
  "inbound.received",
  "service.permissions_changed",
]);

const callbackInputSchema = z.object({
  serviceId: identifierSchema,
  name: z.string().trim().min(2).max(120),
  url: z.string().trim().url().max(2_048),
  secret: z.string().min(16).max(512).optional(),
  events: z.array(callbackEventSchema).min(1, "Select at least one callback event").max(7),
}).strict();

const domainInputSchema = z.object({
  domain: domainNameSchema,
  accountIds: z.array(identifierSchema).max(20),
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
  const version = (await query<{ credential_version: number }>("SELECT credential_version FROM provider_credentials WHERE provider_account_id=$1 AND status='active'", [id])).rows[0]?.credential_version;
  const account = await loadProviderAccount(id, { allowNonActive: true });
  let health: { healthy: boolean; details?: Record<string, unknown> };
  try {
    health = await account.module.health.check(account.context)
  } catch (error) {
    health = { healthy: false, details: { error: error instanceof Error ? error.message : "Connection failed" } }
  }
  await transaction(async client => {
    await client.query("SELECT id FROM provider_accounts WHERE id=$1 FOR UPDATE", [id]);
    const updated = await client.query("UPDATE provider_accounts SET status=CASE WHEN status='disabled' THEN 'disabled' WHEN $2 THEN 'active' ELSE 'degraded' END,health=$3,updated_at=now() WHERE id=$1 AND EXISTS(SELECT 1 FROM provider_credentials WHERE provider_account_id=$1 AND status='active' AND credential_version=$4) RETURNING id", [id, health.healthy, {
      status: health.healthy ? "healthy" : "unhealthy", checkedAt: new Date().toISOString(), credentialVersion: version, ...health.details
    }, version]);
    if (!updated.rowCount) throw new Error("Credentials changed during this test. Test the current credentials again.");
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_account.test','provider_account',$2,$3)", [actor, id, { healthy: health.healthy, credentialVersion: version }]);
  });
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
    await client.query("SELECT id FROM provider_accounts WHERE id=$1 FOR UPDATE", [id]);
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
  const domainId = (await query<{ id: string }>("INSERT INTO sending_domains(id,domain) VALUES ($1,$2) ON CONFLICT(domain) DO UPDATE SET domain=excluded.domain RETURNING id", [createId("sd"), domain])).rows[0].id;
  const results = [];
  for (const { accountId, account, identity } of accounts) {
    const existing = (await query<{ id: string; status: string }>("SELECT id,status FROM provider_identities WHERE sending_domain_id=$1 AND provider_account_id=$2", [domainId, accountId])).rows[0];
    if (existing) { results.push({ accountId, status: existing.status, existing: true }); continue }
    const identityId = createId("pi");
    if (!identity) {
      await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status,dns_records,last_checked_at) VALUES ($1,$2,$3,'verified','[]',now())", [identityId, domainId, accountId]);
      results.push({ accountId, status: "verified", verification: "provider_dashboard" });
      continue
    }
    try {
      const created = await identity.createIdentity(domain, account.context);
      await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,external_identity_id,status,dns_records,last_checked_at) VALUES ($1,$2,$3,$4,$5,$6,now())", [identityId, domainId, accountId, created.externalIdentityId, created.status, JSON.stringify(created.dnsRecords)]);
      results.push({ accountId, status: created.status })
    } catch (error) {
      await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status,dns_records,last_checked_at) VALUES ($1,$2,$3,'failed','[]',now())", [identityId, domainId, accountId]);
      results.push({ accountId, status: "failed", error: error instanceof Error ? error.message : "Identity setup failed" })
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
    await query("UPDATE provider_identities SET external_identity_id=$2,status=$3,dns_records=$4,last_checked_at=now(),updated_at=now() WHERE id=$1", [id, result.externalIdentityId, result.status, JSON.stringify(result.dnsRecords)]);
    await audit(actor, "provider_identity.refresh", "provider_identity", id, { status: result.status });
    return result
  }
  const result = await account.module.identity.checkIdentity(row.external_identity_id, account.context);
  await query("UPDATE provider_identities SET status=$2,dns_records=$3,last_checked_at=now(),updated_at=now() WHERE id=$1", [id, result.status, JSON.stringify(result.dnsRecords)]);
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

export async function createRoutingPolicy(input: {
  name: string;
  productId?: string;
  serviceId?: string;
  domainId: string;
  category?: string;
  priority?: number;
  targets: Array<{ accountId: string; identityId: string; priority?: number; weight?: number; rateLimit?: number }>
}, actor: string, existingId?: string) {
  const validated = routingPolicyInputSchema.parse(input);
  const id = existingId ?? createId("rp");
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
    if (existingId) {
      const current = await client.query("SELECT id FROM routing_policies WHERE id=$1 FOR UPDATE", [id]);
      if (!current.rowCount) throw new Error("Routing policy not found");
      await client.query("DELETE FROM routing_targets WHERE policy_id=$1", [id]);
      await client.query("UPDATE routing_policies SET name=$2,product_id=$3,service_id=$4,sending_domain_id=$5,message_category=$6,priority=$7,updated_at=now() WHERE id=$1", [id, validated.name, productId ?? null, validated.serviceId ?? null, validated.domainId, validated.category ?? null, validated.priority]);
    } else {
    await client.query("INSERT INTO routing_policies(id,name,product_id,service_id,sending_domain_id,message_category,priority) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id, validated.name, productId ?? null, validated.serviceId ?? null, validated.domainId, validated.category ?? null, validated.priority]);
    }
    for (const target of validated.targets) await client.query("INSERT INTO routing_targets(id,policy_id,provider_account_id,provider_identity_id,priority,weight,rate_limit_per_minute) VALUES ($1,$2,$3,$4,$5,$6,$7)", [createId("rt"), id, target.accountId, target.identityId, target.priority, target.weight, target.rateLimit]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,$4,'routing_policy',$2,$3)", [actor, id, {
      productId: productId ?? null,
      serviceId: validated.serviceId ?? null,
      domainId: validated.domainId,
      category: validated.category ?? null,
      priority: validated.priority,
      targetCount: validated.targets.length
    }, existingId ? "routing_policy.update" : "routing_policy.create"])
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
    CROSS JOIN LATERAL(SELECT count(*)FILTER(WHERE da.started_at>=date_trunc('month',now())AND da.status IN('submitting','accepted','reconciled','unknown','reconciling'))monthly_usage,count(*)FILTER(WHERE da.started_at>=date_trunc('day',now())AND da.status IN('submitting','accepted','reconciled','unknown','reconciling'))daily_usage FROM submission_attempts da JOIN submission_deliveries sm ON sm.submission_id=da.submission_id WHERE da.provider_account_id=pa.id)usage
    WHERE rp.status='active' AND rp.sending_domain_id=$1 AND pi.sending_domain_id=$1 AND (rp.product_id IS NULL OR rp.product_id=$2) AND (rp.service_id IS NULL OR rp.service_id=$3) AND (rp.message_category IS NULL OR rp.message_category=$4) ORDER BY rp.priority,rt.priority,rt.id`, [domainId, input.productId || null, input.serviceId || null, input.category || null]);
  const candidates = result.rows.map(row => {
    const reasons = evaluateCandidate(row);
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
  return retryDelivery(id, { actor, acknowledgeUnknown: acknowledgeDuplicateRisk })
}

export async function replayRawEvent(id: string, actor: string) {
  await transaction(async client => {
    const updated = await client.query("UPDATE raw_provider_events SET processed_at=NULL,processing_error=NULL,processing_attempt_count=0,next_attempt_at=now() WHERE id=$1 AND content_purged_at IS NULL AND terminated_at IS NULL RETURNING id", [id]);
    if (!updated.rowCount) throw new Error("Raw event not found or its content has expired.");
    await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'raw_provider_event',$2,$3,$4)", [createId("out"), id, PROVIDER_EVENT_RECEIVED, { rawEventId: id }]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id) VALUES ($1,'provider_event.replay','raw_provider_event',$2)", [actor, id])
  })
}

export async function terminateRawEvent(id:string,actor:string) {
  await transaction(async client => {
    await client.query("SELECT id FROM inbound_messages WHERE raw_provider_event_id=$1 ORDER BY id FOR UPDATE",[id]);
    const raw=(await client.query<{provider_account_id:string}>(`SELECT provider_account_id FROM raw_provider_events WHERE id=$1 AND terminated_at IS NULL
      AND processed_at IS NULL AND processing_attempt_count>=20 AND processing_error IS NOT NULL AND next_attempt_at<=now() FOR UPDATE`,[id])).rows[0];
    if (!raw) throw new Error("Only an exhausted, inactive raw event can be terminated");
    const active=await client.query("SELECT id FROM inbound_messages WHERE raw_provider_event_id=$1 AND status='scanning' AND processing_token IS NOT NULL AND processing_deadline_at>now()",[id]);
    if(active.rowCount) throw new Error("Inbound copy processing is still active");
    await client.query("UPDATE inbound_receipts SET terminated_at=clock_timestamp() WHERE provider_account_id=$2 AND external_message_id IN (SELECT external_message_id FROM inbound_messages WHERE raw_provider_event_id=$1)",[id,raw.provider_account_id]);
    await client.query("UPDATE inbound_messages SET status='rejected',rejection_reason='INBOUND_PROCESSING_TERMINATED',processing_token=NULL,processing_deadline_at=NULL WHERE raw_provider_event_id=$1 AND status='scanning'",[id]);
    await client.query("UPDATE raw_provider_events SET terminated_at=clock_timestamp() WHERE id=$1",[id]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id) VALUES($1,'provider_event.terminate','raw_provider_event',$2)",[actor,id]);
  });
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
  message: CreateMessageInput;
  idempotencyKey: string;
}, actor: string) {
  const row = (await query<{
    service_id: string; service_name: string; product_id: string; product_name: string;
  }>(`SELECT s.id AS service_id,s.name AS service_name,p.id AS product_id,p.name AS product_name
      FROM services s JOIN products p ON p.id=s.product_id
      WHERE s.id=$1 AND p.status='active'`, [input.serviceId])).rows[0];
  if (!row) throw new Error("The selected service is unavailable");
  const message = createMessageSchema.parse(input.message);
  const result = await acceptMessage({
    identity: {
      serviceId: row.service_id, serviceName: row.service_name,
      productId: row.product_id, product: row.product_name,
      rateLimitPerMinute: SERVICE_REQUESTS_PER_MINUTE,
    },
    idempotencyKey: `admin-test-${z.string().uuid().parse(input.idempotencyKey)}`,
    input: message,
  });
  await audit(actor, "message.test_send", "message", result.message.id, { serviceId: input.serviceId });
  return result.message;
}

export async function setDomainGrant(input:z.input<typeof domainGrantInputSchema>,actor:string){
  const v=domainGrantInputSchema.parse(input);
  return transaction(async client=>{
    if(!(await client.query("SELECT s.id FROM services s JOIN products p ON p.id=s.product_id WHERE s.id=$1 AND p.status='active' AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM sending_domains d WHERE d.id=$2 AND d.status='active')) FOR UPDATE OF s",[v.serviceId,v.domainId])).rowCount) throw new Error("Select an active business service and domain");
    await client.query("UPDATE services SET configuration_revision=configuration_revision+1,updated_at=now() WHERE id=$1",[v.serviceId]);
    const conflictTarget=v.domainId===null?"(service_id) WHERE sending_domain_id IS NULL":"(service_id,sending_domain_id)";
    const id=(await client.query<{id:string}>(`INSERT INTO service_domain_grants(id,service_id,sending_domain_id,send_allowed,receive_allowed) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT ${conflictTarget} DO UPDATE SET send_allowed=EXCLUDED.send_allowed,receive_allowed=EXCLUDED.receive_allowed,status='active',revision=service_domain_grants.revision+1,updated_at=now() RETURNING id`,[createId('dg'),v.serviceId,v.domainId,v.send,v.receive])).rows[0].id;
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES($1,'domain_grant.set','service_domain_grant',$2,$3)",[actor,id,v]);await queuePermissionsChanged(client,v.serviceId);return id;
  });
}
export async function toggleDomainGrant(id:string,enabled:boolean,actor:string){
  await transaction(async client=>{
    const owner=(await client.query<{service_id:string}>("SELECT g.service_id FROM service_domain_grants g JOIN services s ON s.id=g.service_id WHERE g.id=$1 FOR UPDATE OF s",[id])).rows[0];
    if (!owner) throw new Error("Domain grant not found");
    await client.query("UPDATE services SET configuration_revision=configuration_revision+1,updated_at=now() WHERE id=$1",[owner.service_id]);
    if(!(await client.query("UPDATE service_domain_grants SET status=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING id",[id,enabled?'active':'disabled'])).rowCount) throw new Error("Domain grant not found");
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES($1,'domain_grant.toggle','service_domain_grant',$2,$3)",[actor,id,{enabled}]);
    const grant=(await client.query<{service_id:string}>("SELECT service_id FROM service_domain_grants WHERE id=$1",[id])).rows[0];await queuePermissionsChanged(client,grant.service_id);
  });
}
export async function rotateServiceCredential(id: string, actor: string) {
  return transaction(async client => {
    const previous = (await client.query<{ service_id: string }>("SELECT service_id FROM service_credentials WHERE id=$1 AND status='active' AND (valid_to IS NULL OR valid_to>now()) FOR UPDATE",[id])).rows[0];
    if (!previous) throw new Error("Active service credential not found");
    const raw = `ev_live_${randomBytes(24).toString("base64url")}`;
    const nextId = createId("cred");
    const overlap = (await client.query<{valid_to:Date}>("UPDATE service_credentials SET valid_to=LEAST(COALESCE(valid_to,now()+interval '24 hours'),now()+interval '24 hours') WHERE id=$1 RETURNING valid_to",[id])).rows[0].valid_to;
    await client.query("INSERT INTO service_credentials(id,service_id,key_prefix,key_hash) VALUES($1,$2,$3,$4)",[nextId,previous.service_id,raw.slice(0,12),hashApiKey(raw)]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES($1,'service_credential.rotate','service_credential',$2,$3)",[actor,nextId,{ previousCredentialId:id,serviceId:previous.service_id,oldCredentialRevoked:false,overlapUntil:overlap.toISOString() }]);
    return { id:nextId,previousCredentialId:id,serviceId:previous.service_id,overlapUntil:overlap.toISOString(),key:raw };
  });
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
    const endpoint = await client.query("UPDATE callback_endpoints SET status=$2,updated_at=now() WHERE id=$1 AND (NOT $3 OR url IS NOT NULL) RETURNING id", [id, enabled ? "active" : "disabled", enabled]);
    if (!endpoint.rows[0]) throw new Error("Configure an Event callback URL before enabling callback delivery");
    if (!enabled) await client.query(`UPDATE callback_deliveries SET status='dead_letter',last_error='Callback endpoint disabled by operator',updated_at=now()
      WHERE endpoint_id=$1 AND status IN ('pending','retrying')`, [id]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'callback_endpoint.toggle','callback_endpoint',$2,$3)", [actor, id, { enabled }]);
  })
}

export async function replaceCallbackSecret(id: string, requestedSecret: string | undefined, actor: string) {
  const secret = requestedSecret?.trim() || `ev_cb_${randomBytes(24).toString("base64url")}`;
  if (secret.length < 16 || secret.length > 512) throw new Error("Callback signing secret must contain 16 to 512 characters");
  return transaction(async client => {
    const current = (await client.query<{ status: string }>("SELECT status FROM callback_endpoints WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!current) throw new Error("Callback endpoint not found");
    if (current.status !== "disabled") throw new Error("Disable callback delivery before replacing its secret");
    if ((await client.query("SELECT id FROM callback_deliveries WHERE endpoint_id=$1 AND status='delivering' LIMIT 1", [id])).rowCount) throw new Error("Wait for in-flight callback deliveries to finish or recover before replacing the secret");
    const envelope = sealSecret({ secret }, id, 1);
    await client.query("UPDATE callback_endpoints SET secret_ciphertext=$2,encrypted_dek=$3,key_version=$4,updated_at=now() WHERE id=$1", [id, envelope.secretCiphertext, envelope.encryptedDek, envelope.keyVersion]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id) VALUES ($1,'callback_endpoint.replace_secret','callback_endpoint',$2)", [actor, id]);
    return { secret }
  })
}

export async function replayDeadLetters(actor: string, scope: { endpointId?: string; deliveryId?: string } = {}) {
  return transaction(async client => {
    const rows = (await client.query<{
      id: string
    }>(`UPDATE callback_deliveries d SET status='pending',attempt_count=0,next_attempt_at=now(),last_error=NULL,updated_at=now()
        FROM callback_endpoints e WHERE d.endpoint_id=e.id AND d.status='dead_letter' AND d.payload_purged_at IS NULL AND e.status='active' AND d.event_type=ANY(e.subscribed_events) AND ($1::text IS NULL OR d.endpoint_id=$1) AND ($2::text IS NULL OR d.id=$2)
        RETURNING d.id`, [scope.endpointId ?? null, scope.deliveryId ?? null])).rows;
    for (const row of rows) await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'callback',$2,'callback.requested',$3)", [createId("out"), row.id, { callbackDeliveryId: row.id }]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'callback_delivery.replay_dead_letters','callback_delivery',NULL,$2)", [actor, { count: rows.length, ...scope }]);
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

export async function createInboundRoute(input:z.input<typeof inboundRouteInputSchema>,actor:string){
  const v=inboundRouteInputSchema.parse(input),id=createId('ir');
  await transaction(async client=>{
    const endpoint=(await client.query<{type:ProviderType;status:string;security_configured:boolean}>("SELECT a.type,e.status,e.security_configured FROM provider_webhook_endpoints e JOIN provider_accounts a ON a.id=e.provider_account_id WHERE e.id=$1",[v.webhookEndpointId])).rows[0];
    if(!endpoint||endpoint.status!=='active'||!endpoint.security_configured||!providerRegistry(endpoint.type).inbound) throw new Error("A configured inbound provider endpoint is required");
    if(!(await client.query(`SELECT s.id FROM services s WHERE s.id=$1 AND s.product_id=$2 AND ${domainPermission("s.id", "$3", "receive")}`,[v.serviceId,v.productId,v.domainId])).rowCount) throw new Error("The service requires receiving permission for this domain");
    await client.query("INSERT INTO inbound_routes(id,provider_webhook_endpoint_id,sending_domain_id,product_id,service_id) VALUES($1,$2,$3,$4,$5)",[id,v.webhookEndpointId,v.domainId,v.productId,v.serviceId]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES($1,'inbound_route.create','inbound_route',$2,$3)",[actor,id,v]);
  });return id;
}

export async function toggleInboundRoute(id: string, enabled: boolean, actor: string) {
  await query("UPDATE inbound_routes SET status=$2 WHERE id=$1", [id, enabled ? "active" : "disabled"]);
  await audit(actor, "inbound_route.toggle", "inbound_route", id, { enabled })
}

export async function updateCallback(id: string, input: { events: string[] }, actor: string) {
  const validated = callbackInputSchema.pick({ events: true }).strict().parse(input);
  await transaction(async client => {
    const updated = await client.query("UPDATE callback_endpoints SET subscribed_events=$2,updated_at=now() WHERE id=$1 AND url IS NOT NULL RETURNING id", [id, validated.events]);
    if (!updated.rowCount) throw new Error("Callback endpoint not found");
    await client.query(`UPDATE callback_deliveries SET status='dead_letter',last_error='CALLBACK_EVENT_NOT_SUBSCRIBED',updated_at=now()
      WHERE endpoint_id=$1 AND NOT(event_type=ANY($2::text[])) AND status IN ('pending','retrying')`,[id,validated.events]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'callback_endpoint.update','callback_endpoint',$2,$3)", [actor,id,{events:validated.events}]);
  })
}

export async function retryOutbox(id: string, actor: string) {
  return transaction(async client => {
    const row=(await client.query<{event_type:string}>("SELECT event_type FROM outbox_events WHERE id=$1 AND status='failed' FOR UPDATE",[id])).rows[0];
    if (!row) throw new Error("Failed work not found; refresh its current state.");
    // A retained failed BullMQ job must be removed before its stable Outbox ID can execute again.
    // If this operation crashes, the unchanged failed Outbox remains safe to retry.
    const job=await queueForEvent(row.event_type).getJob(id);
    if (job) {
      const state=await job.getState();
      if (state==="active") throw new Error("This work is still executing. Wait for it to finish.");
      await job.remove();
    }
    await client.query("UPDATE outbox_events SET status='pending',attempt_count=0,available_at=now() WHERE id=$1",[id]);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id) VALUES ($1,'outbox.retry','outbox_event',$2)",[actor,id]);
    return {id}
  })
}
