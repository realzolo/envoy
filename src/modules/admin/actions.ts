import { randomBytes } from "node:crypto";
import { z } from "zod";
import { providerConfigSchema, providerSecretSchema, type ProviderType } from "@/modules/providers/contracts";
import { loadProviderAccount } from "@/modules/config/provider-account";
import { sealSecret } from "@/modules/config/envelope";
import { acceptMessage } from "@/modules/core/message/service";
import { choosePolicyTarget } from "@/modules/core/routing/engine";
import { createId } from "@/server/ids";
import { hashApiKey } from "@/server/crypto";
import { query, transaction } from "@/server/database";
import { PROVIDER_EVENT_RECEIVED } from "@/server/outbox-events";

async function audit(actor: string, action: string, type: string, id: string | null, details: Record<string, unknown> = {}) {
  await query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,$2,$3,$4,$5)", [actor, action, type, id, details])
}

async function revision(client: import("pg").PoolClient, type: string, id: string, config: unknown, actor: string) {
  const current = await client.query<{
    revision: number
  }>("SELECT revision FROM config_revisions WHERE resource_type=$1 AND resource_id=$2 ORDER BY revision DESC LIMIT 1", [type, id]);
  await client.query("INSERT INTO config_revisions(resource_type,resource_id,revision,config,actor) VALUES ($1,$2,$3,$4,$5)", [type, id, (current.rows[0]?.revision ?? 0) + 1, config, actor])
}

export async function createProduct(input: { name: string; slug: string }, actor: string) {
  const validated = z.object({
    name: z.string().trim().min(2).max(120),
    slug: z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  }).parse(input);
  const id = createId("prd");
  await transaction(async client => {
    await client.query("INSERT INTO products(id,slug,name) VALUES ($1,$2,$3)", [id, validated.slug, validated.name]);
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
  region: string;
  publicConfig: Record<string, unknown>;
  secret: Record<string, unknown>;
  webhookSecurity: Record<string, unknown>;
  expectedTopicArn?: string;
  ipAllowlist?: string[]
}, actor: string) {
  if (input.type === "mock") throw new Error("Mock providers are available only to automated tests");
  const config = providerConfigSchema.parse({ type: input.type, schemaVersion: 1, ...input.publicConfig });
  const secret = providerSecretSchema.parse({ type: input.type, ...input.secret });
  const accountId = createId("pa");
  const credential = sealSecret(secret, accountId, 1);
  const endpointId = createId("pwe");
  const security = sealSecret(input.webhookSecurity, endpointId, 1);
  const opaqueToken = randomBytes(24).toString("base64url");
  const publicConfig = { ...config } as Record<string, unknown>;
  delete publicConfig.type;
  delete publicConfig.schemaVersion;
  await transaction(async client => {
    await client.query("INSERT INTO provider_accounts(id,type,name,region,public_config) VALUES ($1,$2,$3,$4,$5)", [accountId, input.type, input.name, input.region, publicConfig]);
    await client.query("INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by) VALUES ($1,$2,1,$3,$4,$5,$6)", [createId("pc"), accountId, credential.secretCiphertext, credential.encryptedDek, credential.keyVersion, actor]);
    await client.query("INSERT INTO provider_webhook_endpoints(id,provider_account_id,opaque_token,security_config_ciphertext,security_encrypted_dek,key_version,expected_topic_arn,ip_allowlist) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [endpointId, accountId, opaqueToken, security.secretCiphertext, security.encryptedDek, security.keyVersion, input.expectedTopicArn ?? null, input.ipAllowlist ?? []]);
    await revision(client, "provider_account", accountId, {
      type: input.type,
      name: input.name,
      region: input.region,
      publicConfig
    }, actor);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_account.create','provider_account',$2,$3)", [actor, accountId, { type: input.type }])
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
  await query("UPDATE provider_accounts SET status=$2,updated_at=now() WHERE id=$1", [id, enabled ? "active" : "disabled"]);
  await audit(actor, "provider_account.toggle", "provider_account", id, { enabled })
}

export async function updateProviderQuota(id: string, quota: Record<string, unknown>, actor: string) {
  const validated = z.object({
    monthlyLimit: z.number().int().nonnegative().optional(),
    dailyLimit: z.number().int().nonnegative().optional()
  }).strict().parse(quota);
  await transaction(async client => {
    await client.query("UPDATE provider_accounts SET quota=$2,config_revision=config_revision+1,updated_at=now() WHERE id=$1", [id, validated]);
    await revision(client, "provider_account", id, { quota: validated }, actor);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_account.quota_update','provider_account',$2,$3)", [actor, id, { quota: validated }])
  })
}

export async function rotateProviderCredential(id: string, secretValue: Record<string, unknown>, actor: string) {
  const account = (await query<{ type: ProviderType }>("SELECT type FROM provider_accounts WHERE id=$1", [id])).rows[0];
  if (!account) throw new Error("Provider account not found");
  const secret = providerSecretSchema.parse({ type: account.type, ...secretValue });
  return transaction(async client => {
    const latest = await client.query<{
      credential_version: number
    }>("SELECT credential_version FROM provider_credentials WHERE provider_account_id=$1 ORDER BY credential_version DESC LIMIT 1", [id]);
    const version = (latest.rows[0]?.credential_version ?? 0) + 1;
    const envelope = sealSecret(secret, id, version);
    await client.query("UPDATE provider_credentials SET status='revoked',valid_to=now() WHERE provider_account_id=$1 AND status='active'", [id]);
    await client.query("INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [createId("pc"), id, version, envelope.secretCiphertext, envelope.encryptedDek, envelope.keyVersion, actor]);
    await revision(client, "provider_credential", id, { credentialVersion: version, status: "active" }, actor);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_credential.rotate','provider_account',$2,$3)", [actor, id, { credentialVersion: version }]);
    return { version }
  })
}

export async function rotateWebhookSecurity(id: string, securityValue: Record<string, unknown>, expectedTopicArn: string | undefined, ipAllowlist: string[] | undefined, actor: string) {
  return transaction(async client => {
    const current = (await client.query<{
      security_version: number;
      expected_topic_arn: string | null;
      ip_allowlist: string[]
    }>("SELECT security_version,expected_topic_arn,ip_allowlist FROM provider_webhook_endpoints WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!current) throw new Error("Webhook endpoint not found");
    const version = current.security_version + 1;
    const envelope = sealSecret(securityValue, id, version);
    const topic = expectedTopicArn === undefined ? current.expected_topic_arn : expectedTopicArn || null;
    const ips = ipAllowlist ?? current.ip_allowlist;
    await client.query("UPDATE provider_webhook_endpoints SET security_config_ciphertext=$2,security_encrypted_dek=$3,key_version=$4,security_version=$5,expected_topic_arn=$6,ip_allowlist=$7,updated_at=now() WHERE id=$1", [id, envelope.secretCiphertext, envelope.encryptedDek, envelope.keyVersion, version, topic, ips]);
    await revision(client, "provider_webhook_endpoint", id, {
      securityVersion: version,
      expectedTopicArn: topic,
      ipAllowlist: ips
    }, actor);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_webhook_endpoint.rotate_security','provider_webhook_endpoint',$2,$3)", [actor, id, { securityVersion: version }]);
    return { version }
  })
}

export async function toggleWebhookEndpoint(id: string, enabled: boolean, actor: string) {
  await query("UPDATE provider_webhook_endpoints SET status=$2,updated_at=now() WHERE id=$1", [id, enabled ? "active" : "disabled"]);
  await audit(actor, "provider_webhook_endpoint.toggle", "provider_webhook_endpoint", id, { enabled })
}

export async function createDomain(input: {
  domain: string;
  region: string;
  inboundEnabled: boolean;
  accountIds: string[]
}, actor: string) {
  const domainId = createId("sd");
  await query("INSERT INTO sending_domains(id,domain,region,inbound_enabled) VALUES ($1,$2,$3,$4)", [domainId, input.domain.toLowerCase(), input.region, input.inboundEnabled]);
  const results = [];
  for (const accountId of input.accountIds) {
    const identityId = createId("pi");
    try {
      const account = await loadProviderAccount(accountId);
      if (!account.module.identity) throw new Error("Provider does not support domain management");
      const identity = await account.module.identity.createIdentity(input.domain, account.context);
      await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,external_identity_id,status,dns_records,last_checked_at,capabilities) VALUES ($1,$2,$3,$4,$5,$6,now(),$7)", [identityId, domainId, accountId, identity.externalIdentityId, identity.status, identity.dnsRecords, account.module.descriptor.capabilities]);
      results.push({ accountId, status: identity.status })
    } catch (error) {
      await query("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status,dns_records,last_checked_at,capabilities) VALUES ($1,$2,$3,'failed','[]',now(),$4)", [identityId, domainId, accountId, { error: error instanceof Error ? error.message : "Identity creation failed" }]);
      results.push({ accountId, status: "failed" })
    }
  }
  await audit(actor, "sending_domain.create", "sending_domain", domainId, {
    domain: input.domain,
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
    external_identity_id: string | null
  }>("SELECT provider_account_id,external_identity_id FROM provider_identities WHERE id=$1", [id])).rows[0];
  if (!row?.external_identity_id) throw new Error("Provider identity is not initialized");
  const account = await loadProviderAccount(row.provider_account_id);
  if (!account.module.identity) throw new Error("Provider does not support domain management");
  const result = await account.module.identity.checkIdentity(row.external_identity_id, account.context);
  await query("UPDATE provider_identities SET status=$2,dns_records=$3,last_checked_at=now(),updated_at=now() WHERE id=$1", [id, result.status, result.dnsRecords]);
  await audit(actor, "provider_identity.refresh", "provider_identity", id, { status: result.status });
  return result
}

export async function toggleIdentity(id: string, enabled: boolean, actor: string) {
  await query("UPDATE provider_identities SET status=$2,updated_at=now() WHERE id=$1", [id, enabled ? "pending" : "disabled"]);
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
  const id = createId("sp");
  await query("INSERT INTO sender_profiles(id,product_id,sending_domain_id,name,from_name,from_local_part,reply_to,message_category) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [id, input.productId, input.domainId, input.name, input.fromName, input.fromLocalPart, input.replyTo || null, input.category]);
  await audit(actor, "sender_profile.create", "sender_profile", id);
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
  category?: string;
  region?: string;
  priority: number;
  targets: Array<{ accountId: string; identityId: string; priority: number; weight: number; rateLimit: number }>
}, actor: string) {
  const id = createId("rp");
  await transaction(async client => {
    await client.query("INSERT INTO routing_policies(id,name,product_id,service_id,message_category,destination_region,priority) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id, input.name, input.productId || null, input.serviceId || null, input.category || null, input.region || null, input.priority]);
    for (const target of input.targets) await client.query("INSERT INTO routing_targets(id,policy_id,provider_account_id,provider_identity_id,priority,weight,rate_limit_per_minute) VALUES ($1,$2,$3,$4,$5,$6,$7)", [createId("rt"), id, target.accountId, target.identityId, target.priority, target.weight, target.rateLimit]);
    await revision(client, "routing_policy", id, input, actor);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'routing_policy.create','routing_policy',$2,$3)", [actor, id, { targetCount: input.targets.length }])
  });
  return id
}

export async function toggleRoutingPolicy(id: string, enabled: boolean, actor: string) {
  await query("UPDATE routing_policies SET status=$2,updated_at=now() WHERE id=$1", [id, enabled ? "active" : "disabled"]);
  await audit(actor, "routing_policy.toggle", "routing_policy", id, { enabled })
}

export async function simulateRouting(input: {
  productId?: string;
  serviceId?: string;
  category?: string;
  region?: string
}) {
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
    WHERE rp.status='active' AND ($1::text IS NULL OR rp.product_id IS NULL OR rp.product_id=$1) AND ($2::text IS NULL OR rp.service_id IS NULL OR rp.service_id=$2) AND ($3::text IS NULL OR rp.message_category IS NULL OR rp.message_category=$3) AND ($4::text IS NULL OR rp.destination_region IS NULL OR rp.destination_region=$4) ORDER BY rp.priority,rt.priority,rt.id`, [input.productId || null, input.serviceId || null, input.category || null, input.region || null]);
  const candidates = result.rows.map(row => {
    const reasons: string[] = [];
    if (row.status === "disabled") reasons.push("target_disabled");
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
  const id = createId("sup");
  await query("INSERT INTO suppressions(id,scope_type,product_id,list_id,email_normalized,reason,source,expires_at) VALUES ($1,$2,$3,$4,$5,$6,'admin',$7)", [id, input.scope, input.productId || null, input.listId || null, input.email.toLowerCase(), input.reason, input.expiresAt || null]);
  await audit(actor, "suppression.create", "suppression", id, { email: input.email });
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
    product_name: string;
    rate_limit_per_minute: number
  }>(`SELECT s.id AS service_id,s.name AS service_name,p.id AS product_id,p.name AS product_name,s.rate_limit_per_minute
      FROM services s JOIN products p ON p.id=s.product_id
      WHERE s.id=$1 AND s.status='active' AND p.status='active'`, [input.serviceId])).rows[0];
  if (!row) throw new Error("The selected service is unavailable");
  const result = await acceptMessage({
    identity: {
      serviceId: row.service_id,
      serviceName: row.service_name,
      productId: row.product_id,
      product: row.product_name,
      rateLimitPerMinute: row.rate_limit_per_minute
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
  return transaction(async client => {
    let service = (await client.query<{
      id: string
    }>("SELECT id FROM services WHERE product_id=$1 AND name=$2", [input.productId, input.serviceName])).rows[0];
    if (!service) {
      service = { id: createId("svc") };
      await client.query("INSERT INTO services(id,product_id,name) VALUES ($1,$2,$3)", [service.id, input.productId, input.serviceName])
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
  secret: string;
  events: string[]
}, actor: string) {
  const id = createId("cb");
  const envelope = sealSecret({ secret: input.secret }, id, 1);
  await query("INSERT INTO callback_endpoints(id,service_id,name,url,secret_ciphertext,encrypted_dek,key_version,subscribed_events) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [id, input.serviceId, input.name, input.url, envelope.secretCiphertext, envelope.encryptedDek, envelope.keyVersion, input.events]);
  await audit(actor, "callback_endpoint.create", "callback_endpoint", id);
  return id
}

export async function toggleCallback(id: string, enabled: boolean, actor: string) {
  await query("UPDATE callback_endpoints SET status=$2,updated_at=now() WHERE id=$1", [id, enabled ? "active" : "disabled"]);
  await audit(actor, "callback_endpoint.toggle", "callback_endpoint", id, { enabled })
}

export async function rotateCallbackSecret(id: string, secret: string, actor: string) {
  if (secret.length < 16) throw new Error("Callback signing secret must contain at least 16 characters");
  return transaction(async client => {
    const current = (await client.query<{
      secret_version: number
    }>("SELECT secret_version FROM callback_endpoints WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!current) throw new Error("Callback endpoint not found");
    const version = current.secret_version + 1;
    const envelope = sealSecret({ secret }, id, version);
    await client.query("UPDATE callback_endpoints SET secret_ciphertext=$2,encrypted_dek=$3,key_version=$4,secret_version=$5,updated_at=now() WHERE id=$1", [id, envelope.secretCiphertext, envelope.encryptedDek, envelope.keyVersion, version]);
    await revision(client, "callback_endpoint", id, { secretVersion: version }, actor);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'callback_endpoint.rotate_secret','callback_endpoint',$2,$3)", [actor, id, { secretVersion: version }]);
    return { version }
  })
}

export async function replayDeadLetters(actor: string) {
  const rows = (await query<{
    id: string
  }>("UPDATE callback_deliveries SET status='pending',next_attempt_at=now(),updated_at=now() WHERE status='dead_letter' RETURNING id")).rows;
  for (const row of rows) await query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'callback',$2,'callback.requested',$3)", [createId("out"), row.id, { callbackDeliveryId: row.id }]);
  await audit(actor, "callback_delivery.replay_dead_letters", "callback_delivery", null, { count: rows.length });
  return rows.length
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
    await client.query("INSERT INTO callback_deliveries(id,endpoint_id,event_type,payload) VALUES ($1,$2,'endpoint.test',$3)", [deliveryId, id, payload]);
    await client.query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES ($1,'callback',$2,'callback.requested',$3)", [createId("out"), deliveryId, { callbackDeliveryId: deliveryId }])
  });
  await audit(actor, "callback_endpoint.test", "callback_endpoint", id);
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
  const id = createId("ir");
  await query("INSERT INTO inbound_routes(id,provider_webhook_endpoint_id,sending_domain_id,local_part_pattern,product_id,service_id,callback_endpoint_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id, input.webhookEndpointId, input.domainId, input.localPartPattern, input.productId, input.serviceId || null, input.callbackId || null]);
  await audit(actor, "inbound_route.create", "inbound_route", id);
  return id
}

export async function toggleInboundRoute(id: string, enabled: boolean, actor: string) {
  await query("UPDATE inbound_routes SET status=$2 WHERE id=$1", [id, enabled ? "active" : "disabled"]);
  await audit(actor, "inbound_route.toggle", "inbound_route", id, { enabled })
}

export async function updateSettings(settings: Record<string, unknown>, actor: string) {
  for (const [key, value] of Object.entries(settings)) await query("INSERT INTO workspace_settings(key,value,updated_at) VALUES ($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=now()", [key, value]);
  await audit(actor, "workspace_settings.update", "workspace", null, { keys: Object.keys(settings) })
}
