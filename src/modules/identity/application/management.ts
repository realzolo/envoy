import { serviceConfigurationSchema,type ServiceConfiguration } from "@/lib/service-configuration";
import { validateCallbackUrl } from "@/modules/callbacks/public";
import { sealSecret } from "@/platform/crypto/envelope";
import { hashApiKey } from "@/platform/crypto/hash";
import { createId } from "@/platform/ids";
import { randomBytes } from "node:crypto";
import { z } from "zod";



const identifierSchema = z.string().trim().min(1).max(160);











const domainGrantInputSchema=z.object({serviceId:identifierSchema,domainId:identifierSchema.nullable(),send:z.boolean(),receive:z.boolean()}).strict().refine(v=>v.send||v.receive,{message:"Select sending or receiving"});









import { ServiceConfigurationConflictError } from '../contracts';
import type { ManagementRepository,ManagementUnitOfWork } from './ports';

export function createManagementService(repository:ManagementRepository,unitOfWork:ManagementUnitOfWork) {
async function audit(actor: string, action: string, type: string, id: string | null, details: Record<string, unknown> = {}) {
  await repository.recordAudit({actor:actor,action:action,resourceType:type,resourceId:id,details:details})
}
async function createProduct(input: { name: string }, actor: string) {
  const validated = z.object({
    name: z.string().trim().min(2).max(120)
  }).parse(input);
  const id = createId("prd");
  await unitOfWork.run(async client => {
    await client.insertProduct({id:id,name:validated.name});
    await client.recordProductCreation({actor:actor,resourceId:id,details:validated})
  });
  return id
}
async function toggleProduct(id: string, enabled: boolean, actor: string) {
  await repository.setProductStatus({id:id,status:enabled ? "active" : "suspended"});
  await audit(actor, "product.toggle", "product", id, { enabled })
}
async function setDomainGrant(input:z.input<typeof domainGrantInputSchema>,actor:string){
  const v=domainGrantInputSchema.parse(input);
  return unitOfWork.run(async client =>{
    if(!(await client.lockActiveServiceAndDomain({id:v.serviceId,idValue:v.domainId})).rowCount) throw new Error("Select an active business service and domain");
    await client.incrementGrantConfigurationRevision({id:v.serviceId});
    
    const id=(await client.upsertDomainGrant({id:createId('dg'),serviceId:v.serviceId,sendingDomainId:v.domainId,sendAllowed:v.send,receiveAllowed:v.receive}, v.domainId)).rows[0].id;
    await client.recordDomainGrant({actor:actor,resourceId:id,details:v});await client.queuePermissionsChanged(v.serviceId);return id;
  });
}
async function toggleDomainGrant(id:string,enabled:boolean,actor:string){
  await unitOfWork.run(async client =>{
    const owner=(await client.lockGrantService({id:id})).rows[0];
    if (!owner) throw new Error("Domain grant not found");
    await client.incrementConfigurationRevision({id:owner.service_id});
    if(!(await client.setDomainGrantStatus({id:id,status:enabled?'active':'disabled'})).rowCount) throw new Error("Domain grant not found");
    await client.recordGrantStatusChange({actor:actor,resourceId:id,details:{enabled}});
    const grant=(await client.findGrantService({id:id})).rows[0];await client.queuePermissionsChanged(grant.service_id);
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
async function replacePermissions(client: ManagementRepository, serviceId: string, config: ServiceConfiguration) {
  const selectedIds = [...new Set([...config.sending.domainIds, ...config.receiving.domainIds])];
  const registered = await client.findRegisteredDomains({selectedIds:selectedIds});
  if (registered.rowCount !== selectedIds.length) throw new Error("Selected domains must be registered");

  // Revoke every previous grant before activating only the requested configuration.
  await client.revokeServiceDomainGrants({serviceId:serviceId});
  const grants = selectedIds.map(domainId => ({ domainId: domainId as string | null, send: config.sending.domainIds.includes(domainId), receive: config.receiving.domainIds.includes(domainId) }));
  if (config.sending.mode === "all" || config.receiving.mode === "all") {
    grants.push({ domainId: null, send: config.sending.mode === "all", receive: config.receiving.mode === "all" });
  }
  for (const grant of grants) {
    await client.upsertServiceDomainPermission({id:createId("dg"),serviceId:serviceId,sendingDomainId:grant.domainId,sendAllowed:grant.send,receiveAllowed:grant.receive}, grant.domainId);
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
    if (!(await client.lockActiveProduct({id:config.productId})).rowCount) throw new Error("Active product required");
    const serviceId = createId("svc");
    await client.insertService({id:serviceId,productId:config.productId,name:config.serviceName,suppressionManagementAllowed:config.suppressionManagement});
    await replacePermissions(client, serviceId, config);
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
    const before = (await client.lockServiceConfiguration({id:serviceId,productId:config.productId})).rows[0];
    if (!before) throw new Error("Active service not found in the selected product");
    if (before.configuration_revision !== expectedRevision) throw new ServiceConfigurationConflictError();
    const previousGrants = (await client.findServiceDomainPermissions({serviceId:serviceId})).rows;
    const previousCallback = (await client.findServiceCallback({serviceId:serviceId})).rows[0] ?? null;
    await client.updateServiceConfiguration({id:serviceId,name:config.serviceName,suppressionManagementAllowed:config.suppressionManagement});
    await replacePermissions(client, serviceId, config);
    const callback = await saveCallback(client, serviceId, config.serviceName, callbackUrl);
    await client.recordServiceUpdate({actor:actor,resourceId:serviceId,details:{ before: { service: before, grants: previousGrants, callback: previousCallback }, configuration: config, appliesTo: "all_service_credentials" }});
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

return {createProduct,toggleProduct,setDomainGrant,toggleDomainGrant,rotateServiceCredential,revokeServiceCredential,createService,updateService,issueServiceCredential};
}
