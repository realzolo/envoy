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
  inboundAccountIds: z.array(identifierSchema).max(20).optional(),
}).strict().superRefine((input, context) => {
  const accounts = new Set<string>();
  input.accountIds.forEach((accountId, index) => {
    if (accounts.has(accountId)) context.addIssue({
      code: "custom", path: ["accountIds", index], message: "A provider account can be selected only once",
    });
    accounts.add(accountId);
  });
  const inboundAccounts = new Set<string>();
  input.inboundAccountIds?.forEach((accountId, index) => {
    if (inboundAccounts.has(accountId)) context.addIssue({
      code: "custom", path: ["inboundAccountIds", index], message: "An inbound account can be selected only once",
    });
    inboundAccounts.add(accountId);
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
  accountIds: string[];
  inboundAccountIds?: string[];
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
  const existingDomain = (await repository.findDomainByName({domain})).rows[0];
  type PreparedIdentity =
    | { accountId: string; kind: "existing" }
    | { accountId: string; kind: "dashboard" }
    | { accountId: string; kind: "managed"; status: string; externalIdentityId: string; dnsRecords: string }
    | { accountId: string; kind: "failed"; error: string };
  const prepared: PreparedIdentity[] = [];
  for (const { accountId, account, identity } of accounts) {
    if (existingDomain && (await repository.findDomainIdentity({sendingDomainId:existingDomain.id,providerAccountId:accountId})).rowCount) {
      prepared.push({accountId,kind:"existing"});
    } else if (!identity) {
      prepared.push({accountId,kind:"dashboard"});
    } else {
      try {
        const created = await identity.createIdentity(domain, account.context);
        prepared.push({accountId,kind:"managed",status:created.status,externalIdentityId:created.externalIdentityId,dnsRecords:JSON.stringify(created.dnsRecords)});
      } catch (error) {
        prepared.push({accountId,kind:"failed",error:error instanceof Error ? error.message : "Identity setup failed"});
      }
    }
  }
  return unitOfWork.run(async client => {
    const inserted = (await client.insertDomain({id:createId("sd"),domain})).rows[0];
    const domainId = inserted?.id ?? (await client.findDomainByName({domain})).rows[0].id;
    const readyInbound = validated.inboundAccountIds === undefined && inserted ? (await client.findReadyInboundAccounts()).rows : [];
    const sourceIds = validated.inboundAccountIds ?? (readyInbound.length === 1 ? [readyInbound[0].id] : []);
    if ((await client.findProviderAccountIds({accountIds:sourceIds})).rows.length !== sourceIds.length)
      throw new Error("Every inbound source account must exist");
    for (const accountId of sourceIds) await client.insertDomainInboundSource({domainId,accountId});
    const results = [];
    for (const setup of prepared) {
      const {accountId} = setup;
      const existing = (await client.findDomainIdentity({sendingDomainId:domainId,providerAccountId:accountId})).rows[0];
      if (existing) { results.push({ accountId, status: existing.status, existing: true }); continue }
      if (setup.kind === "existing") throw new Error("Provider identity changed during registration. Retry this request.");
      const identityId = createId("pi");
      if (setup.kind === "dashboard") {
        await client.insertDashboardIdentity({id:identityId,sendingDomainId:domainId,providerAccountId:accountId});
        results.push({ accountId, status: "verified", verification: "provider_dashboard" });
      } else if (setup.kind === "managed") {
        await client.insertManagedIdentity({id:identityId,sendingDomainId:domainId,providerAccountId:accountId,externalIdentityId:setup.externalIdentityId,status:setup.status,dnsRecords:setup.dnsRecords});
        results.push({ accountId, status: setup.status });
      } else if (setup.kind === "failed") {
        await client.insertFailedIdentity({id:identityId,sendingDomainId:domainId,providerAccountId:accountId});
        results.push({ accountId, status: "failed", error: setup.error });
      }
    }
    await client.recordAudit({actor,action:"sending_domain.create",resourceType:"sending_domain",resourceId:domainId,details:{domain,identities:results,inboundAccountIds:sourceIds}});
    return { domainId, identities: results }
  });
}
async function setDomainInboundSources(id: string, accountIdsInput: unknown, actor: string) {
  const accountIds = z.array(identifierSchema).max(20).refine(ids => new Set(ids).size === ids.length, "Inbound accounts must be unique").parse(accountIdsInput);
  await unitOfWork.run(async client => {
    if (!(await client.lockDomain({id})).rowCount) throw new Error("Domain not found");
    if ((await client.findProviderAccountIds({accountIds})).rows.length !== accountIds.length)
      throw new Error("Every inbound source account must exist");
    await client.replaceDomainInboundSources({domainId:id,accountIds});
    for (const accountId of accountIds) await client.insertDomainInboundSource({domainId:id,accountId});
    await client.notifyDomainBindingsChanged({domainId:id,receiveOnly:true});
    await client.recordAudit({actor,action:"sending_domain.inbound_sources_update",resourceType:"sending_domain",resourceId:id,details:{accountIds}});
  });
}
async function toggleDomain(id: string, enabled: boolean, actor: string) {
  await unitOfWork.run(async client => {
    const current = (await client.lockDomain({id})).rows[0];
    if (!current) throw new Error("Domain not found");
    const status = enabled ? "active" : "disabled";
    if (current.status === status) return;
    await client.setDomainStatus({id,status});
    await client.notifyDomainBindingsChanged({domainId:id,receiveOnly:false});
    await client.recordAudit({actor,action:"sending_domain.toggle",resourceType:"sending_domain",resourceId:id,details:{enabled}});
  });
}
async function refreshIdentity(id: string, actor: string) {
  const row = (await repository.findIdentityAccount({id:id})).rows[0];
  if (!row) throw new Error("Provider identity not found");
  if (row.status === "disabled") throw new Error("Enable this provider identity before refreshing it");
  const account = await loadProviderAccount(row.provider_account_id);
  if (!account.module.identity) throw new Error("This domain is verified in the provider dashboard and cannot be refreshed by Envoy");
  if (!row.external_identity_id) {
    const result = await account.module.identity.createIdentity(row.domain, account.context);
    const saved = await repository.saveCreatedIdentity({id:id,externalIdentityId:result.externalIdentityId,status:result.status,dnsRecords:JSON.stringify(result.dnsRecords)});
    if (!saved.rows[0] || saved.rows[0].status === "disabled") throw new Error("Provider identity was disabled during refresh");
    await audit(actor, "provider_identity.refresh", "provider_identity", id, { status: result.status });
    return result
  }
  const result = await account.module.identity.checkIdentity(row.external_identity_id, account.context);
  const saved = await repository.saveIdentityVerification({id:id,status:result.status,dnsRecords:JSON.stringify(result.dnsRecords)});
  if (!saved.rowCount) throw new Error("Provider identity was disabled during refresh");
  await audit(actor, "provider_identity.refresh", "provider_identity", id, { status: result.status });
  return result
}
async function toggleIdentity(id: string, enabled: boolean, actor: string) {
  const identity = (await repository.findIdentityProviderType({id:id})).rows[0];
  if (!identity) throw new Error("Provider identity not found");
  await repository.setIdentityStatus({id:id,status:enabled ? providerRegistry(identity.type).identity ? "pending" : "verified" : "disabled"});
  await audit(actor, "provider_identity.toggle", "provider_identity", id, { enabled })
}

return {createProviderAccount,testProviderAccount,toggleProvider,updateProviderQuota,rotateProviderCredential,configureProviderWebhook,toggleWebhookEndpoint,createDomain,setDomainInboundSources,toggleDomain,refreshIdentity,toggleIdentity};
}
