import {
domainNameSchema,
providerConfigSchema,
providerSecretSchema,
providerWebhookSettingsSchema,
type ProviderType
} from "@/integrations/providers/contracts";
import { providerRegistry } from "@/integrations/providers/public";
import { sealSecret } from "@/platform/crypto/envelope";
import { createId } from "@/platform/ids";
import { randomBytes } from "node:crypto";
import { z } from "zod";



const identifierSchema = z.string().trim().min(1).max(160);

















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



import type { ChannelDependencies,ManagementRepository,ManagementUnitOfWork } from './ports';

export function createManagementService(repository:ManagementRepository,unitOfWork:ManagementUnitOfWork,dependencies:ChannelDependencies) {
const {loadProviderAccount}=dependencies;
async function audit(actor: string, action: string, type: string, id: string | null, details: Record<string, unknown> = {}) {
  await repository.recordAudit({actor:actor,action:action,resourceType:type,resourceId:id,details:details})
}
async function createProviderAccount(input: {
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
  await unitOfWork.run(async client => {
    await client.insertProviderAccount({id:accountId,type:input.type,name:name,publicConfig:publicConfig});
    await client.insertInitialCredential({id:createId("pc"),providerAccountId:accountId,secretCiphertext:credential.secretCiphertext,encryptedDek:credential.encryptedDek,keyVersion:credential.keyVersion,createdBy:actor});
    await client.insertWebhookEndpoint({id:endpointId,providerAccountId:accountId,opaqueToken:opaqueToken});
    await client.recordAccountCreation({actor:actor,resourceId:accountId,details:{
      type: input.type,
      name,
      configuration: publicConfig
    }})
  });
  return { accountId, webhookPath: `/api/provider-events/${input.type}/${opaqueToken}` }
}
async function testProviderAccount(id: string, actor: string) {
  const version = (await repository.findActiveCredentialVersion({providerAccountId:id})).rows[0]?.credential_version;
  const account = await loadProviderAccount(id, { allowNonActive: true });
  let health: { healthy: boolean; details?: Record<string, unknown> };
  try {
    health = await account.module.health.check(account.context)
  } catch (error) {
    health = { healthy: false, details: { error: error instanceof Error ? error.message : "Connection failed" } }
  }
  await unitOfWork.run(async client => {
    await client.lockProviderAccount({id:id});
    const updated = await client.saveCredentialHealth({id:id,healthy:health.healthy,health:{
      status: health.healthy ? "healthy" : "unhealthy", checkedAt: new Date().toISOString(), credentialVersion: version, ...health.details
    },credentialVersion:version});
    if (!updated.rowCount) throw new Error("Credentials changed during this test. Test the current credentials again.");
    await client.recordHealthCheck({actor:actor,resourceId:id,details:{ healthy: health.healthy, credentialVersion: version }});
  });
  return health
}
async function toggleProvider(id: string, enabled: boolean, actor: string) {
  await repository.setProviderAccountStatus({id:id,status:enabled ? "degraded" : "disabled"});
  await audit(actor, "provider_account.toggle", "provider_account", id, { enabled })
}
async function updateProviderQuota(id: string, quota: Record<string, unknown>, actor: string) {
  const validated = z.object({
    monthlyLimit: z.number().int().nonnegative().optional(),
    dailyLimit: z.number().int().nonnegative().optional()
  }).strict().parse(quota);
  await unitOfWork.run(async client => {
    await client.saveProviderQuota({id:id,quota:validated});
    await client.recordQuotaUpdate({actor:actor,resourceId:id,details:{ quota: validated }})
  })
}
async function rotateProviderCredential(id: string, secretValue: Record<string, unknown>, actor: string) {
  const account = (await repository.findProviderType({id:id})).rows[0];
  if (!account) throw new Error("Provider account not found");
  const secret = providerSecretSchema.parse({ ...secretValue, type: account.type });
  return unitOfWork.run(async client => {
    await client.lockCredentialAccount({id:id});
    const latest = await client.findLatestCredentialVersion({providerAccountId:id});
    const version = (latest.rows[0]?.credential_version ?? 0) + 1;
    const envelope = sealSecret(secret, id, version);
    await client.revokeActiveCredentials({providerAccountId:id});
    await client.insertProviderCredential({id:createId("pc"),providerAccountId:id,credentialVersion:version,secretCiphertext:envelope.secretCiphertext,encryptedDek:envelope.encryptedDek,keyVersion:envelope.keyVersion,createdBy:actor});
    await client.invalidateCredentialHealth({id:id,health:{
      status: "unknown",
      credentialRotatedAt: new Date().toISOString()
    }});
    await client.recordCredentialRotation({actor:actor,resourceId:id,details:{ credentialVersion: version, requiresTest: true }});
    return { version, requiresTest: true }
  })
}
async function configureProviderWebhook(id: string, settingsValue: Record<string, unknown>, actor: string) {
  return unitOfWork.run(async client => {
    const current = (await client.lockWebhookSecurity({id:id})).rows[0];
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
    await client.saveWebhookSecurity({id:id,securityConfigCiphertext:envelope.secretCiphertext,securityEncryptedDek:envelope.encryptedDek,keyVersion:envelope.keyVersion,securityVersion:version,expectedTopicArn:topic,ipAllowlist:ips});
    await client.recordWebhookSecurityUpdate({actor:actor,resourceId:id,details:{
      securityVersion: version,
      expectedTopicArn: topic,
      ipAllowlist: ips
    }});
    return { version, configured: true }
  })
}
async function toggleWebhookEndpoint(id: string, enabled: boolean, actor: string) {
  await repository.setWebhookStatus({id:id,status:enabled ? "active" : "disabled"});
  await audit(actor, "provider_webhook_endpoint.toggle", "provider_webhook_endpoint", id, { enabled })
}
async function createDomain(input: {
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
  const domainId = (await repository.upsertDomain({id:createId("sd"),domain:domain})).rows[0].id;
  const results = [];
  for (const { accountId, account, identity } of accounts) {
    const existing = (await repository.findDomainIdentity({sendingDomainId:domainId,providerAccountId:accountId})).rows[0];
    if (existing) { results.push({ accountId, status: existing.status, existing: true }); continue }
    const identityId = createId("pi");
    if (!identity) {
      await repository.insertDashboardIdentity({id:identityId,sendingDomainId:domainId,providerAccountId:accountId});
      results.push({ accountId, status: "verified", verification: "provider_dashboard" });
      continue
    }
    try {
      const created = await identity.createIdentity(domain, account.context);
      await repository.insertManagedIdentity({id:identityId,sendingDomainId:domainId,providerAccountId:accountId,externalIdentityId:created.externalIdentityId,status:created.status,dnsRecords:JSON.stringify(created.dnsRecords)});
      results.push({ accountId, status: created.status })
    } catch (error) {
      await repository.insertFailedIdentity({id:identityId,sendingDomainId:domainId,providerAccountId:accountId});
      results.push({ accountId, status: "failed", error: error instanceof Error ? error.message : "Identity setup failed" })
    }
  }
  await audit(actor, "sending_domain.create", "sending_domain", domainId, {
    domain,
    identities: results
  });
  return { domainId, identities: results }
}
async function toggleDomain(id: string, enabled: boolean, actor: string) {
  await repository.setDomainStatus({id:id,status:enabled ? "active" : "disabled"});
  await audit(actor, "sending_domain.toggle", "sending_domain", id, { enabled })
}
async function refreshIdentity(id: string, actor: string) {
  const row = (await repository.findIdentityAccount({id:id})).rows[0];
  if (!row) throw new Error("Provider identity not found");
  const account = await loadProviderAccount(row.provider_account_id);
  if (!account.module.identity) throw new Error("This domain is verified in the provider dashboard and cannot be refreshed by Envoy");
  if (!row.external_identity_id) {
    const result = await account.module.identity.createIdentity(row.domain, account.context);
    await repository.saveCreatedIdentity({id:id,externalIdentityId:result.externalIdentityId,status:result.status,dnsRecords:JSON.stringify(result.dnsRecords)});
    await audit(actor, "provider_identity.refresh", "provider_identity", id, { status: result.status });
    return result
  }
  const result = await account.module.identity.checkIdentity(row.external_identity_id, account.context);
  await repository.saveIdentityVerification({id:id,status:result.status,dnsRecords:JSON.stringify(result.dnsRecords)});
  await audit(actor, "provider_identity.refresh", "provider_identity", id, { status: result.status });
  return result
}
async function toggleIdentity(id: string, enabled: boolean, actor: string) {
  const identity = (await repository.findIdentityProviderType({id:id})).rows[0];
  if (!identity) throw new Error("Provider identity not found");
  await repository.setIdentityStatus({id:id,status:enabled ? providerRegistry(identity.type).identity ? "pending" : "verified" : "disabled"});
  await audit(actor, "provider_identity.toggle", "provider_identity", id, { enabled })
}

return {createProviderAccount,testProviderAccount,toggleProvider,updateProviderQuota,rotateProviderCredential,configureProviderWebhook,toggleWebhookEndpoint,createDomain,toggleDomain,refreshIdentity,toggleIdentity};
}
