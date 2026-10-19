import { serviceConfigurationSchema,type ServiceConfiguration } from "@/lib/service-configuration";
import { validateCallbackUrl } from "@/modules/callbacks/public";
import { sealSecret } from "@/platform/crypto/envelope";
import { hashApiKey } from "@/platform/crypto/hash";
import { createId } from "@/platform/ids";
import { randomBytes } from "node:crypto";

import { ServiceConfigurationConflictError } from '../contracts';
import type { ManagementRepository,ManagementUnitOfWork } from './ports';

export function createManagementService(repository:ManagementRepository,unitOfWork:ManagementUnitOfWork) {
async function audit(actor: string, action: string, type: string, id: string | null, details: Record<string, unknown> = {}) {
  await repository.recordAudit({actor:actor,action:action,resourceType:type,resourceId:id,details:details})
}
async function toggleService(id: string, enabled: boolean, actor: string) {
  return unitOfWork.run(async client => {
    if (!(await client.lockServiceConfiguration({ id })).rowCount) throw new Error("Service not found");
    await client.setServiceStatus({ id, status: enabled ? "active" : "suspended" });
    await client.recordAudit({ actor, action: "service.toggle", resourceType: "service", resourceId: id, details: { enabled } });
    await client.queuePermissionsChanged(id);
  });
}
async function rotateServiceCredential(id: string, actor: string) {
  return unitOfWork.run(async client => {
    const previous = (await client.lockActiveCredential({id:id})).rows[0];
    if (!previous) throw new Error("Active service credential not found");
    const raw = `ev_live_${randomBytes(24).toString("base64url")}`;
    const nextId = createId("cred");
    const overlap = (await client.limitCredentialOverlap({id:id})).rows[0].valid_to;
    await client.insertRotatedCredential({id:nextId,serviceId:previous.service_id,keyPrefix:raw.slice(0,12),keyHash:hashApiKey(raw)});
    await client.recordCredentialRotation({actor:actor,resourceId:nextId,details:{ previousCredentialId:id,serviceId:previous.service_id,oldCredentialRevoked:false,overlapUntil:overlap.toISOString() }});
    return { id:nextId,previousCredentialId:id,serviceId:previous.service_id,overlapUntil:overlap.toISOString(),key:raw };
  });
}
async function revokeServiceCredential(id: string, actor: string) {
  await repository.revokeCredential({id:id});
  await audit(actor, "service_credential.revoke", "service_credential", id)
}
async function replaceBindings(client: ManagementRepository, serviceId: string, config: ServiceConfiguration) {
  const selectedIds = config.domains.map(binding => binding.domainId);
  const registered = await client.findRegisteredDomains({ selectedIds });
  if (registered.rows.length !== selectedIds.length || registered.rows.some(domain => domain.status !== "active")) {
    throw new Error("Every selected domain must be registered and active");
  }
  const domains = new Map(registered.rows.map(domain => [domain.id, domain]));
  if (config.domains.some(binding => binding.receive && !domains.get(binding.domainId)?.inbound_ready)) {
    throw new Error("Receiving requires a configured inbound provider for the domain");
  }
  const identityIds = config.domains.flatMap(binding => binding.outboundIdentityId ? [binding.outboundIdentityId] : []);
  const identities = await client.findProviderIdentities({ identityIds });
  const byId = new Map(identities.rows.map(identity => [identity.id, identity]));
  if (identities.rows.length !== identityIds.length || config.domains.some(binding => {
    if (!binding.outboundIdentityId) return false;
    const identity = byId.get(binding.outboundIdentityId);
    return !identity || identity.sending_domain_id !== binding.domainId || identity.status !== "verified" || identity.account_status !== "active";
  })) throw new Error("Sending requires a verified provider identity for the selected domain");
  await client.deleteServiceBindings({ serviceId });
  for (const binding of config.domains) {
    await client.insertServiceBinding({ id: createId("sdb"), serviceId, domainId: binding.domainId,
      receive: binding.receive, outboundIdentityId: binding.outboundIdentityId });
  }
}

async function saveCallback(client: ManagementRepository, serviceId: string, name: string, url: string) {
  const existing = (await client.lockServiceCallback({serviceId:serviceId})).rows[0];
  if (existing) {
    // Editing another service field must not resume an endpoint paused by an operator.
    const status = !url ? "disabled" : !existing.url ? "active" : existing.status;
    await client.saveServiceCallback({id:existing.id,name:name,url:url || null,status:status});
    if (!url) await client.stopPendingCallbackDeliveries({endpointId:existing.id});
    return undefined;
  }
  if (!url) return undefined;
  const id = createId("cb"), secret = `ev_cb_${randomBytes(24).toString("base64url")}`;
  const envelope = sealSecret({ secret }, id, 1);
  await client.insertServiceCallback({id:id,serviceId:serviceId,name:name,url:url,secretCiphertext:envelope.secretCiphertext,encryptedDek:envelope.encryptedDek,keyVersion:envelope.keyVersion,subscribedEvents:["email.accepted", "email.delivered", "email.bounced", "email.failed", "email.suppressed", "inbound.received", "service.permissions_changed"]});
  return { id, secret };
}

async function issueKey(client: ManagementRepository, serviceId: string, actor: string) {
  const key = `ev_live_${randomBytes(24).toString("base64url")}`, id = createId("cred");
  await client.insertServiceCredential({id:id,serviceId:serviceId,keyPrefix:key.slice(0, 12),keyHash:hashApiKey(key)});
  await client.recordCredentialIssue({actor:actor,resourceId:id,details:{ serviceId }});
  return { id, serviceId, key };
}

async function createService(input: unknown, actor: string) {
  const config = serviceConfigurationSchema.parse(input);
  const target = config.callbackUrl ? await validateCallbackUrl(config.callbackUrl) : null;
  return unitOfWork.run(async client => {
    const serviceId = createId("svc");
    await client.insertService({id:serviceId,name:config.serviceName,suppressionManagementAllowed:config.suppressionManagement});
    await replaceBindings(client, serviceId, config);
    const callback = await saveCallback(client, serviceId, config.serviceName, target ?? "");
    const credential = await issueKey(client, serviceId, actor);
    await client.recordServiceCreation({actor:actor,resourceId:serviceId,details:{ configuration: config }});
    return { ...credential, callback };
  });
}

async function updateService(serviceId: string, input: unknown, expectedRevision: number, actor: string) {
  const config = serviceConfigurationSchema.parse(input);
  const callbackBefore = (await repository.findServiceCallback({serviceId:serviceId})).rows[0];
  const callbackUrl = config.callbackUrl && config.callbackUrl !== callbackBefore?.url
    ? await validateCallbackUrl(config.callbackUrl) : config.callbackUrl;
  return unitOfWork.run(async client => {
    const before = (await client.lockServiceConfiguration({id:serviceId})).rows[0];
    if (!before) throw new Error("Service not found");
    if (before.configuration_revision !== expectedRevision) throw new ServiceConfigurationConflictError();
    const previousBindings = (await client.findServiceBindings({serviceId:serviceId})).rows;
    const previousCallback = (await client.findServiceCallback({serviceId:serviceId})).rows[0] ?? null;
    await client.updateServiceConfiguration({id:serviceId,name:config.serviceName,suppressionManagementAllowed:config.suppressionManagement});
    await replaceBindings(client, serviceId, config);
    const callback = await saveCallback(client, serviceId, config.serviceName, callbackUrl);
    await client.recordServiceUpdate({actor:actor,resourceId:serviceId,details:{ before: { service: before, bindings: previousBindings, callback: previousCallback }, configuration: config, appliesTo: "all_service_credentials" }});
    await client.queuePermissionsChanged(serviceId);
    return { id: serviceId, callback };
  });
}

async function issueServiceCredential(serviceId: string, actor: string) {
  return unitOfWork.run(async client => {
    if (!(await client.lockActiveService({id:serviceId})).rowCount) throw new Error("Active service required");
    return issueKey(client, serviceId, actor);
  });
}

return {toggleService,rotateServiceCredential,revokeServiceCredential,createService,updateService,issueServiceCredential};
}
