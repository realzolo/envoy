import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { serviceConfigurationSchema, type ServiceConfiguration } from "@/lib/service-configuration";
import { resolveCallbackTarget } from "@/modules/callbacks/url-policy";
import { sealSecret } from "@/modules/config/envelope";
import { hashApiKey } from "@/server/crypto";
import { transaction } from "@/server/database";
import { createId } from "@/server/ids";
import { queuePermissionsChanged } from "./permission-notifications";

export class ServiceConfigurationConflictError extends Error {
  constructor() { super("This service was changed by another administrator. Close the editor, refresh, and review the latest configuration before saving."); }
}

async function replacePermissions(client: PoolClient, serviceId: string, config: ServiceConfiguration) {
  const selectedIds = [...new Set([...config.sending.domainIds, ...config.receiving.domainIds])];
  const registered = await client.query("SELECT id FROM sending_domains WHERE id=ANY($1::text[])", [selectedIds]);
  if (registered.rowCount !== selectedIds.length) throw new Error("Selected domains must be registered");

  // Revoke every previous grant before activating only the requested configuration.
  await client.query("UPDATE service_domain_grants SET status='disabled',revision=revision+1,updated_at=now() WHERE service_id=$1 AND status='active'", [serviceId]);
  const grants = selectedIds.map(domainId => ({ domainId: domainId as string | null, send: config.sending.domainIds.includes(domainId), receive: config.receiving.domainIds.includes(domainId) }));
  if (config.sending.mode === "all" || config.receiving.mode === "all") {
    grants.push({ domainId: null, send: config.sending.mode === "all", receive: config.receiving.mode === "all" });
  }
  for (const grant of grants) {
    const conflictTarget = grant.domainId === null ? "(service_id) WHERE sending_domain_id IS NULL" : "(service_id,sending_domain_id)";
    await client.query(`INSERT INTO service_domain_grants(id,service_id,sending_domain_id,send_allowed,receive_allowed) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT ${conflictTarget} DO UPDATE SET send_allowed=EXCLUDED.send_allowed,receive_allowed=EXCLUDED.receive_allowed,status='active',revision=service_domain_grants.revision+1,updated_at=now()`,
    [createId("dg"), serviceId, grant.domainId, grant.send, grant.receive]);
  }
}

async function saveCallback(client: PoolClient, serviceId: string, name: string, url: string) {
  const existing = (await client.query<{ id: string; url: string | null; status: string }>("SELECT id,url,status FROM callback_endpoints WHERE service_id=$1 FOR UPDATE", [serviceId])).rows[0];
  if (existing) {
    // Editing another service field must not resume an endpoint paused by an operator.
    const status = !url ? "disabled" : !existing.url ? "active" : existing.status;
    await client.query("UPDATE callback_endpoints SET name=$2,url=$3,status=$4,updated_at=now() WHERE id=$1", [existing.id, name, url || null, status]);
    if (!url) await client.query("UPDATE callback_deliveries SET status='dead_letter',last_error='Event callback URL removed from service configuration',updated_at=now() WHERE endpoint_id=$1 AND status IN ('pending','retrying')", [existing.id]);
    return undefined;
  }
  if (!url) return undefined;
  const id = createId("cb"), secret = `ev_cb_${randomBytes(24).toString("base64url")}`;
  const envelope = sealSecret({ secret }, id, 1);
  await client.query("INSERT INTO callback_endpoints(id,service_id,name,url,secret_ciphertext,encrypted_dek,key_version,subscribed_events) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [id, serviceId, name, url, envelope.secretCiphertext, envelope.encryptedDek, envelope.keyVersion, ["email.accepted", "email.delivered", "email.bounced", "email.failed", "email.suppressed", "inbound.received", "service.permissions_changed"]]);
  return { id, secret };
}

async function issueKey(client: PoolClient, serviceId: string, actor: string) {
  const key = `ev_live_${randomBytes(24).toString("base64url")}`, id = createId("cred");
  await client.query("INSERT INTO service_credentials(id,service_id,key_prefix,key_hash) VALUES($1,$2,$3,$4)", [id, serviceId, key.slice(0, 12), hashApiKey(key)]);
  await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES($1,'service_credential.issue','service_credential',$2,$3)", [actor, id, { serviceId }]);
  return { id, serviceId, key };
}

export async function createService(input: unknown, actor: string) {
  const config = serviceConfigurationSchema.parse(input);
  const target = config.callbackUrl ? await resolveCallbackTarget(config.callbackUrl) : null;
  return transaction(async client => {
    if (!(await client.query("SELECT id FROM products WHERE id=$1 AND status='active' FOR SHARE", [config.productId])).rowCount) throw new Error("Active product required");
    const serviceId = createId("svc");
    await client.query("INSERT INTO services(id,product_id,name,suppression_management_allowed) VALUES($1,$2,$3,$4)", [serviceId, config.productId, config.serviceName, config.suppressionManagement]);
    await replacePermissions(client, serviceId, config);
    const callback = await saveCallback(client, serviceId, config.serviceName, target?.url.toString() ?? "");
    const credential = await issueKey(client, serviceId, actor);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES($1,'service.create','service',$2,$3)", [actor, serviceId, { configuration: config }]);
    return { ...credential, callback };
  });
}

export async function updateService(serviceId: string, input: unknown, expectedRevision: number, actor: string) {
  const config = serviceConfigurationSchema.parse(input);
  return transaction(async client => {
    const before = (await client.query("SELECT s.* FROM services s JOIN products p ON p.id=s.product_id WHERE s.id=$1 AND s.product_id=$2 AND p.status='active' FOR UPDATE OF s FOR SHARE OF p", [serviceId, config.productId])).rows[0];
    if (!before) throw new Error("Active service not found in the selected product");
    if (before.configuration_revision !== expectedRevision) throw new ServiceConfigurationConflictError();
    const previousGrants = (await client.query("SELECT sending_domain_id,send_allowed,receive_allowed,status FROM service_domain_grants WHERE service_id=$1", [serviceId])).rows;
    const previousCallback = (await client.query("SELECT url,status FROM callback_endpoints WHERE service_id=$1", [serviceId])).rows[0] ?? null;
    // Unchanged URLs need no DNS lookup when only permissions are being edited.
    const callbackUrl = config.callbackUrl && config.callbackUrl !== previousCallback?.url
      ? (await resolveCallbackTarget(config.callbackUrl)).url.toString() : config.callbackUrl;
    await client.query("UPDATE services SET name=$2,suppression_management_allowed=$3,configuration_revision=configuration_revision+1,updated_at=now() WHERE id=$1", [serviceId, config.serviceName, config.suppressionManagement]);
    await replacePermissions(client, serviceId, config);
    const callback = await saveCallback(client, serviceId, config.serviceName, callbackUrl);
    await client.query("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES($1,'service.update','service',$2,$3)",
      [actor, serviceId, { before: { service: before, grants: previousGrants, callback: previousCallback }, configuration: config, appliesTo: "all_service_credentials" }]);
    await queuePermissionsChanged(client, serviceId);
    return { id: serviceId, callback };
  });
}

export async function issueServiceCredential(serviceId: string, actor: string) {
  return transaction(async client => {
    if (!(await client.query("SELECT s.id FROM services s JOIN products p ON p.id=s.product_id WHERE s.id=$1 AND p.status='active' FOR SHARE OF s", [serviceId])).rowCount) throw new Error("Active service required");
    return issueKey(client, serviceId, actor);
  });
}
