import { database, query, transaction, transactionContext } from '@/platform/database';
import { notifyDomainBindingsChanged } from '@/modules/identity/public';
import { providerAccounts, providerWebhookEndpoints, sendingDomains } from '@/platform/database/schema/channels';
import { eq, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import type * as RepositoryRows from '../application/ports';
import type { ManagementRepository, ManagementUnitOfWork } from '../application/ports';

export function createManagementRepository(client?: PoolClient): ManagementRepository {
  return {
    recordAudit(input: {
      actor: string;
      action: string;
      resourceType: string;
      resourceId: null | string;
      details: unknown
    }) {
      return client ? client.query<RepositoryRows.RecordAuditRow>("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,$2,$3,$4,$5)", [input.actor, input.action, input.resourceType, input.resourceId, input.details]) : query<RepositoryRows.RecordAuditRow>("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,$2,$3,$4,$5)", [input.actor, input.action, input.resourceType, input.resourceId, input.details]);
    },
    insertProviderAccount(input: { id: string; type: string; name: string; publicConfig: unknown }) {
      return client ? client.query<RepositoryRows.InsertProviderAccountRow>("INSERT INTO provider_accounts(id,type,name,public_config) VALUES ($1,$2,$3,$4)", [input.id, input.type, input.name, input.publicConfig]) : query<RepositoryRows.InsertProviderAccountRow>("INSERT INTO provider_accounts(id,type,name,public_config) VALUES ($1,$2,$3,$4)", [input.id, input.type, input.name, input.publicConfig]);
    },
    insertInitialCredential(input: {
      id: string;
      providerAccountId: string;
      secretCiphertext: string;
      encryptedDek: string;
      keyVersion: string;
      createdBy: string
    }) {
      return client ? client.query<RepositoryRows.InsertInitialCredentialRow>("INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by) VALUES ($1,$2,1,$3,$4,$5,$6)", [input.id, input.providerAccountId, input.secretCiphertext, input.encryptedDek, input.keyVersion, input.createdBy]) : query<RepositoryRows.InsertInitialCredentialRow>("INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by) VALUES ($1,$2,1,$3,$4,$5,$6)", [input.id, input.providerAccountId, input.secretCiphertext, input.encryptedDek, input.keyVersion, input.createdBy]);
    },
    insertWebhookEndpoint(input: { id: string; providerAccountId: string; opaqueToken: string }) {
      return client ? client.query<RepositoryRows.InsertWebhookEndpointRow>("INSERT INTO provider_webhook_endpoints(id,provider_account_id,opaque_token) VALUES ($1,$2,$3)", [input.id, input.providerAccountId, input.opaqueToken]) : query<RepositoryRows.InsertWebhookEndpointRow>("INSERT INTO provider_webhook_endpoints(id,provider_account_id,opaque_token) VALUES ($1,$2,$3)", [input.id, input.providerAccountId, input.opaqueToken]);
    },
    recordAccountCreation(input: { actor: string; resourceId: string; details: unknown }) {
      return client ? client.query<RepositoryRows.RecordAccountCreationRow>("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_account.create','provider_account',$2,$3)", [input.actor, input.resourceId, input.details]) : query<RepositoryRows.RecordAccountCreationRow>("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_account.create','provider_account',$2,$3)", [input.actor, input.resourceId, input.details]);
    },
    findActiveCredentialVersion(input: { providerAccountId: string }) {
      return client ? client.query<RepositoryRows.FindActiveCredentialVersionRow>("SELECT credential_version FROM provider_credentials WHERE provider_account_id=$1 AND status='active'", [input.providerAccountId]) : query<RepositoryRows.FindActiveCredentialVersionRow>("SELECT credential_version FROM provider_credentials WHERE provider_account_id=$1 AND status='active'", [input.providerAccountId]);
    },
    lockProviderAccount(input: { id: string }) {
      return client ? client.query<RepositoryRows.LockProviderAccountRow>("SELECT id FROM provider_accounts WHERE id=$1 FOR UPDATE", [input.id]) : query<RepositoryRows.LockProviderAccountRow>("SELECT id FROM provider_accounts WHERE id=$1 FOR UPDATE", [input.id]);
    },
    saveCredentialHealth(input: { id: string; healthy: boolean; health: unknown; credentialVersion: number }) {
      return client ? client.query<RepositoryRows.SaveCredentialHealthRow>("UPDATE provider_accounts SET status=CASE WHEN status='disabled' THEN 'disabled' WHEN $2 THEN 'active' ELSE 'degraded' END,health=$3,updated_at=now() WHERE id=$1 AND EXISTS(SELECT 1 FROM provider_credentials WHERE provider_account_id=$1 AND status='active' AND credential_version=$4) RETURNING id", [input.id, input.healthy, input.health, input.credentialVersion]) : query<RepositoryRows.SaveCredentialHealthRow>("UPDATE provider_accounts SET status=CASE WHEN status='disabled' THEN 'disabled' WHEN $2 THEN 'active' ELSE 'degraded' END,health=$3,updated_at=now() WHERE id=$1 AND EXISTS(SELECT 1 FROM provider_credentials WHERE provider_account_id=$1 AND status='active' AND credential_version=$4) RETURNING id", [input.id, input.healthy, input.health, input.credentialVersion]);
    },
    recordHealthCheck(input: { actor: string; resourceId: string; details: unknown }) {
      return client ? client.query<RepositoryRows.RecordHealthCheckRow>("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_account.test','provider_account',$2,$3)", [input.actor, input.resourceId, input.details]) : query<RepositoryRows.RecordHealthCheckRow>("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_account.test','provider_account',$2,$3)", [input.actor, input.resourceId, input.details]);
    },
    async setProviderAccountStatus(input: { id: string; status: string }) {
      const result = await database(client).update(providerAccounts).set({
        status: input.status,
        updatedAt: sql`now()`
      }).where(eq(providerAccounts.id, input.id));
      return { rows: [], rowCount: result.rowCount };
    },
    async saveProviderQuota(input: { id: string; quota: unknown }) {
      const result = await database(client).update(providerAccounts).set({
        quota: input.quota,
        updatedAt: sql`now()`
      }).where(eq(providerAccounts.id, input.id));
      return { rows: [], rowCount: result.rowCount };
    },
    recordQuotaUpdate(input: { actor: string; resourceId: string; details: unknown }) {
      return client ? client.query<RepositoryRows.RecordQuotaUpdateRow>("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_account.quota_update','provider_account',$2,$3)", [input.actor, input.resourceId, input.details]) : query<RepositoryRows.RecordQuotaUpdateRow>("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_account.quota_update','provider_account',$2,$3)", [input.actor, input.resourceId, input.details]);
    },
    findProviderType(input: { id: string }) {
      return client ? client.query<RepositoryRows.FindProviderTypeRow>("SELECT type FROM provider_accounts WHERE id=$1", [input.id]) : query<RepositoryRows.FindProviderTypeRow>("SELECT type FROM provider_accounts WHERE id=$1", [input.id]);
    },
    lockCredentialAccount(input: { id: string }) {
      return client ? client.query<RepositoryRows.LockCredentialAccountRow>("SELECT id FROM provider_accounts WHERE id=$1 FOR UPDATE", [input.id]) : query<RepositoryRows.LockCredentialAccountRow>("SELECT id FROM provider_accounts WHERE id=$1 FOR UPDATE", [input.id]);
    },
    findLatestCredentialVersion(input: { providerAccountId: string }) {
      return client ? client.query<RepositoryRows.FindLatestCredentialVersionRow>("SELECT credential_version FROM provider_credentials WHERE provider_account_id=$1 ORDER BY credential_version DESC LIMIT 1", [input.providerAccountId]) : query<RepositoryRows.FindLatestCredentialVersionRow>("SELECT credential_version FROM provider_credentials WHERE provider_account_id=$1 ORDER BY credential_version DESC LIMIT 1", [input.providerAccountId]);
    },
    revokeActiveCredentials(input: { providerAccountId: string }) {
      return client ? client.query<RepositoryRows.RevokeActiveCredentialsRow>("UPDATE provider_credentials SET status='revoked',valid_to=now() WHERE provider_account_id=$1 AND status='active'", [input.providerAccountId]) : query<RepositoryRows.RevokeActiveCredentialsRow>("UPDATE provider_credentials SET status='revoked',valid_to=now() WHERE provider_account_id=$1 AND status='active'", [input.providerAccountId]);
    },
    insertProviderCredential(input: {
      id: string;
      providerAccountId: string;
      credentialVersion: number;
      secretCiphertext: string;
      encryptedDek: string;
      keyVersion: string;
      createdBy: string
    }) {
      return client ? client.query<RepositoryRows.InsertProviderCredentialRow>("INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [input.id, input.providerAccountId, input.credentialVersion, input.secretCiphertext, input.encryptedDek, input.keyVersion, input.createdBy]) : query<RepositoryRows.InsertProviderCredentialRow>("INSERT INTO provider_credentials(id,provider_account_id,credential_version,secret_ciphertext,encrypted_dek,key_version,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [input.id, input.providerAccountId, input.credentialVersion, input.secretCiphertext, input.encryptedDek, input.keyVersion, input.createdBy]);
    },
    invalidateCredentialHealth(input: { id: string; health: unknown }) {
      return client ? client.query<RepositoryRows.InvalidateCredentialHealthRow>("UPDATE provider_accounts SET status=CASE WHEN status='disabled' THEN 'disabled' ELSE 'degraded' END,health=$2,updated_at=now() WHERE id=$1", [input.id, input.health]) : query<RepositoryRows.InvalidateCredentialHealthRow>("UPDATE provider_accounts SET status=CASE WHEN status='disabled' THEN 'disabled' ELSE 'degraded' END,health=$2,updated_at=now() WHERE id=$1", [input.id, input.health]);
    },
    recordCredentialRotation(input: { actor: string; resourceId: string; details: unknown }) {
      return client ? client.query<RepositoryRows.RecordCredentialRotationRow>("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_credential.rotate','provider_account',$2,$3)", [input.actor, input.resourceId, input.details]) : query<RepositoryRows.RecordCredentialRotationRow>("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_credential.rotate','provider_account',$2,$3)", [input.actor, input.resourceId, input.details]);
    },
    lockWebhookSecurity(input: { id: string }) {
      return client ? client.query<RepositoryRows.LockWebhookSecurityRow>(`SELECT e.security_version,a.type
      FROM provider_webhook_endpoints e
      JOIN provider_accounts a ON a.id=e.provider_account_id
      WHERE e.id=$1 FOR UPDATE`, [input.id]) : query<RepositoryRows.LockWebhookSecurityRow>(`SELECT e.security_version,a.type
      FROM provider_webhook_endpoints e
      JOIN provider_accounts a ON a.id=e.provider_account_id
      WHERE e.id=$1 FOR UPDATE`, [input.id]);
    },
    saveWebhookSecurity(input: {
      id: string;
      securityConfigCiphertext: unknown;
      securityEncryptedDek: unknown;
      keyVersion: string;
      securityVersion: number;
      expectedTopicArn: null | string;
      ipAllowlist: unknown[]
    }) {
      return client ? client.query<RepositoryRows.SaveWebhookSecurityRow>("UPDATE provider_webhook_endpoints SET security_config_ciphertext=$2,security_encrypted_dek=$3,key_version=$4,security_version=$5,security_configured=true,expected_topic_arn=$6,ip_allowlist=$7,updated_at=now() WHERE id=$1", [input.id, input.securityConfigCiphertext, input.securityEncryptedDek, input.keyVersion, input.securityVersion, input.expectedTopicArn, input.ipAllowlist]) : query<RepositoryRows.SaveWebhookSecurityRow>("UPDATE provider_webhook_endpoints SET security_config_ciphertext=$2,security_encrypted_dek=$3,key_version=$4,security_version=$5,security_configured=true,expected_topic_arn=$6,ip_allowlist=$7,updated_at=now() WHERE id=$1", [input.id, input.securityConfigCiphertext, input.securityEncryptedDek, input.keyVersion, input.securityVersion, input.expectedTopicArn, input.ipAllowlist]);
    },
    recordWebhookSecurityUpdate(input: { actor: string; resourceId: string; details: unknown }) {
      return client ? client.query<RepositoryRows.RecordWebhookSecurityUpdateRow>("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_webhook_endpoint.rotate_security','provider_webhook_endpoint',$2,$3)", [input.actor, input.resourceId, input.details]) : query<RepositoryRows.RecordWebhookSecurityUpdateRow>("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details) VALUES ($1,'provider_webhook_endpoint.rotate_security','provider_webhook_endpoint',$2,$3)", [input.actor, input.resourceId, input.details]);
    },
    async setWebhookStatus(input: { id: string; status: string }) {
      const result = await database(client).update(providerWebhookEndpoints).set({
        status: input.status,
        updatedAt: sql`now()`
      }).where(eq(providerWebhookEndpoints.id, input.id));
      return { rows: [], rowCount: result.rowCount };
    },
    insertDomain(input: { id: string; domain: string }) {
      return client ? client.query<RepositoryRows.InsertDomainRow>("INSERT INTO sending_domains(id,domain) VALUES ($1,$2) ON CONFLICT(domain) DO NOTHING RETURNING id", [input.id, input.domain]) : query<RepositoryRows.InsertDomainRow>("INSERT INTO sending_domains(id,domain) VALUES ($1,$2) ON CONFLICT(domain) DO NOTHING RETURNING id", [input.id, input.domain]);
    },
    findDomainByName(input: { domain: string }) {
      return client ? client.query<RepositoryRows.FindDomainByNameRow>("SELECT id FROM sending_domains WHERE domain=$1", [input.domain]) : query<RepositoryRows.FindDomainByNameRow>("SELECT id FROM sending_domains WHERE domain=$1", [input.domain]);
    },
    findReadyInboundAccounts() {
      const sql = "SELECT a.id FROM provider_accounts a JOIN provider_webhook_endpoints e ON e.provider_account_id=a.id AND e.status='active' AND e.security_configured WHERE a.status='active' ORDER BY a.id";
      return client ? client.query<RepositoryRows.FindReadyInboundAccountRow>(sql) : query<RepositoryRows.FindReadyInboundAccountRow>(sql);
    },
    findProviderAccountIds(input: { accountIds: string[] }) {
      const sql = "SELECT id FROM provider_accounts WHERE id=ANY($1::text[])";
      return client ? client.query<RepositoryRows.FindProviderAccountIdRow>(sql, [input.accountIds]) : query<RepositoryRows.FindProviderAccountIdRow>(sql, [input.accountIds]);
    },
    insertDomainInboundSource(input: { domainId: string; accountId: string }) {
      const sql = "INSERT INTO domain_inbound_sources(sending_domain_id,provider_account_id) VALUES($1,$2) ON CONFLICT DO NOTHING";
      return client ? client.query<never>(sql, [input.domainId, input.accountId]) : query<never>(sql, [input.domainId, input.accountId]);
    },
    replaceDomainInboundSources(input: { domainId: string; accountIds: string[] }) {
      if (!client) throw new Error("Inbound source update requires a transaction");
      return client.query<never>("DELETE FROM domain_inbound_sources WHERE sending_domain_id=$1 AND provider_account_id<>ALL($2::text[])", [input.domainId, input.accountIds]);
    },
    lockDomain(input: { id: string }) {
      if (!client) throw new Error("Domain lock requires a transaction");
      return client.query<RepositoryRows.LockDomainRow>("SELECT id,status FROM sending_domains WHERE id=$1 FOR UPDATE", [input.id]);
    },
    async notifyDomainBindingsChanged(input: { domainId: string; receiveOnly: boolean }) {
      if (!client) throw new Error("Domain notifications require a transaction");
      await notifyDomainBindingsChanged(input.domainId, input.receiveOnly, transactionContext(client));
    },
    findDomainIdentity(input: { sendingDomainId: string; providerAccountId: string }) {
      return client ? client.query<RepositoryRows.FindDomainIdentityRow>("SELECT id,status FROM provider_identities WHERE sending_domain_id=$1 AND provider_account_id=$2", [input.sendingDomainId, input.providerAccountId]) : query<RepositoryRows.FindDomainIdentityRow>("SELECT id,status FROM provider_identities WHERE sending_domain_id=$1 AND provider_account_id=$2", [input.sendingDomainId, input.providerAccountId]);
    },
    insertDashboardIdentity(input: { id: string; sendingDomainId: string; providerAccountId: string }) {
      return client ? client.query<RepositoryRows.InsertDashboardIdentityRow>("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status,dns_records,last_checked_at) VALUES ($1,$2,$3,'verified','[]',now())", [input.id, input.sendingDomainId, input.providerAccountId]) : query<RepositoryRows.InsertDashboardIdentityRow>("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status,dns_records,last_checked_at) VALUES ($1,$2,$3,'verified','[]',now())", [input.id, input.sendingDomainId, input.providerAccountId]);
    },
    insertManagedIdentity(input: {
      id: string;
      sendingDomainId: string;
      providerAccountId: string;
      externalIdentityId: string;
      status: string;
      dnsRecords: string
    }) {
      return client ? client.query<RepositoryRows.InsertManagedIdentityRow>("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,external_identity_id,status,dns_records,last_checked_at) VALUES ($1,$2,$3,$4,$5,$6,now())", [input.id, input.sendingDomainId, input.providerAccountId, input.externalIdentityId, input.status, input.dnsRecords]) : query<RepositoryRows.InsertManagedIdentityRow>("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,external_identity_id,status,dns_records,last_checked_at) VALUES ($1,$2,$3,$4,$5,$6,now())", [input.id, input.sendingDomainId, input.providerAccountId, input.externalIdentityId, input.status, input.dnsRecords]);
    },
    insertFailedIdentity(input: { id: string; sendingDomainId: string; providerAccountId: string }) {
      return client ? client.query<RepositoryRows.InsertFailedIdentityRow>("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status,dns_records) VALUES ($1,$2,$3,'failed','[]')", [input.id, input.sendingDomainId, input.providerAccountId]) : query<RepositoryRows.InsertFailedIdentityRow>("INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status,dns_records) VALUES ($1,$2,$3,'failed','[]')", [input.id, input.sendingDomainId, input.providerAccountId]);
    },
    async setDomainStatus(input: { id: string; status: string }) {
      const result = await database(client).update(sendingDomains).set({
        status: input.status, ...(input.status === "active" ? { archivedAt: null } : {}),
        updatedAt: sql`clock_timestamp()`
      }).where(eq(sendingDomains.id, input.id));
      return { rows: [], rowCount: result.rowCount };
    },
    async archiveDomain(input) {
      if (!client) throw new Error("Archive requires a transaction");
      await client.query("UPDATE sending_domains SET status='disabled',archived_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [input.id]);
      await client.query("UPDATE provider_identities SET sync_lease_token=NULL,sync_lease_until=NULL,updated_at=clock_timestamp() WHERE sending_domain_id=$1", [input.id]);
      await client.query("UPDATE service_domain_bindings SET receive_enabled=false,outbound_provider_identity_id=NULL,updated_at=clock_timestamp() WHERE sending_domain_id=$1", [input.id]);
    },
    async archiveIdentity(input) {
      if (!client) throw new Error("Archive requires a transaction");
      await client.query("UPDATE provider_identities SET status='disabled',archived_at=clock_timestamp(),sync_lease_until=NULL,sync_lease_token=NULL,updated_at=clock_timestamp() WHERE id=$1", [input.id]);
      await client.query("UPDATE service_domain_bindings SET outbound_provider_identity_id=NULL,updated_at=clock_timestamp() WHERE outbound_provider_identity_id=$1", [input.id]);
    },
    recordIdentitySyncFailure(input) {
      const sql = `UPDATE provider_identities pi SET
 sync_lease_token=CASE WHEN $5::text IS NULL THEN NULL ELSE sync_lease_token END,sync_lease_until=CASE WHEN $5::text IS NULL THEN NULL ELSE sync_lease_until END,status=CASE WHEN $4 THEN 'failed' ELSE status END,sync_attempt_at=clock_timestamp(),sync_error=CASE WHEN $4 THEN 'Domain missing in this provider account. Check the team or repair the binding.' ELSE 'Provider sync failed. Check account access and retry.' END,
 updated_at=CASE WHEN $4 THEN clock_timestamp() ELSE updated_at END
 WHERE id=$1 AND status<>'disabled' AND updated_at=$2::timestamptz
 AND ($5::text IS NULL OR (sync_lease_token=$5 AND sync_lease_until>clock_timestamp()))
 AND EXISTS(SELECT 1 FROM provider_credentials c WHERE c.id=$3 AND c.provider_account_id=pi.provider_account_id AND c.status='active' AND c.valid_from<=now() AND (c.valid_to IS NULL OR c.valid_to>now())) RETURNING id`;
      const args = [input.id, input.version, input.credentialId, input.missing, input.leaseToken ?? null];
      return client ? client.query<{ id: string }>(sql, args) : query<{ id: string }>(sql, args);
    },
    lockIdentity(input) {
      const sql = "SELECT id FROM provider_identities WHERE id=$1 FOR UPDATE";
      return (client ? client.query<{ id: string }>(sql, [input.id]) : query<{ id: string }>(sql, [input.id]));
    },
    deleteUnusedIdentity(input) {
      const sql = `DELETE FROM provider_identities pi WHERE pi.id=$1
 AND NOT EXISTS(SELECT 1 FROM service_domain_bindings b WHERE b.outbound_provider_identity_id=pi.id)
 AND NOT EXISTS(SELECT 1 FROM submission_attempts a WHERE a.provider_identity_id=pi.id) RETURNING id`;
      return (client ? client.query<{ id: string }>(sql, [input.id]) : query<{ id: string }>(sql, [input.id]));
    },
    deleteUnusedDomain(input) {
      const sql = `DELETE FROM sending_domains d WHERE d.id=$1
 AND NOT EXISTS(SELECT 1 FROM service_domain_bindings b WHERE b.sending_domain_id=d.id)
 AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.sending_domain_id=d.id)
 AND NOT EXISTS(SELECT 1 FROM outbound_files f WHERE f.sending_domain_id=d.id)
 AND NOT EXISTS(SELECT 1 FROM submission_attempts a JOIN provider_identities pi ON pi.id=a.provider_identity_id WHERE pi.sending_domain_id=d.id) RETURNING id`;
      return (client ? client.query<{ id: string }>(sql, [input.id]) : query<{ id: string }>(sql, [input.id]));
    },
    saveIdentitySnapshot(input) {
      const sql = `UPDATE provider_identities pi SET external_identity_id=$2,status=$3,dns_records=$4,last_checked_at=clock_timestamp(),sync_attempt_at=clock_timestamp(),sync_error=NULL,sync_lease_token=CASE WHEN $7::text IS NULL THEN NULL ELSE sync_lease_token END,sync_lease_until=CASE WHEN $7::text IS NULL THEN NULL ELSE sync_lease_until END,updated_at=clock_timestamp()
 WHERE pi.id=$1 AND pi.status<>'disabled' AND pi.updated_at=$5::timestamptz
 AND ($7::text IS NULL OR (pi.sync_lease_token=$7 AND pi.sync_lease_until>clock_timestamp()))
 AND EXISTS(SELECT 1 FROM provider_credentials c WHERE c.id=$6 AND c.provider_account_id=pi.provider_account_id AND c.status='active' AND c.valid_from<=now() AND (c.valid_to IS NULL OR c.valid_to>now())) RETURNING pi.status`;
      return (client ? client.query<{
        status: string
      }>(sql, [input.id, input.externalIdentityId, input.status, input.dnsRecords, input.version, input.credentialId, input.leaseToken ?? null]) : query<{
        status: string
      }>(sql, [input.id, input.externalIdentityId, input.status, input.dnsRecords, input.version, input.credentialId, input.leaseToken ?? null]));
    },
    findIdentityAccount(input: { id: string }) {
      return client ? client.query<RepositoryRows.FindIdentityAccountRow>(`SELECT pi.sending_domain_id,pi.provider_account_id,pi.external_identity_id,pi.status,sd.domain,pi.updated_at::text AS version,
      (SELECT c.id FROM provider_credentials c WHERE c.provider_account_id=pi.provider_account_id AND c.status='active' AND c.valid_from<=now() AND (c.valid_to IS NULL OR c.valid_to>now())) AS credential_id
      FROM provider_identities pi JOIN sending_domains sd ON sd.id=pi.sending_domain_id
      WHERE pi.id=$1`, [input.id]) : query<RepositoryRows.FindIdentityAccountRow>(`SELECT pi.sending_domain_id,pi.provider_account_id,pi.external_identity_id,pi.status,sd.domain,pi.updated_at::text AS version,
      (SELECT c.id FROM provider_credentials c WHERE c.provider_account_id=pi.provider_account_id AND c.status='active' AND c.valid_from<=now() AND (c.valid_to IS NULL OR c.valid_to>now())) AS credential_id
      FROM provider_identities pi JOIN sending_domains sd ON sd.id=pi.sending_domain_id
      WHERE pi.id=$1`, [input.id]);
    },
    saveCreatedIdentity(input: { id: string; externalIdentityId: string; status: string; dnsRecords: string }) {
      return client ? client.query<RepositoryRows.SaveCreatedIdentityRow>("UPDATE provider_identities SET external_identity_id=$2,status=CASE WHEN status='disabled' THEN status ELSE $3 END,dns_records=$4,last_checked_at=now(),updated_at=now() WHERE id=$1 RETURNING status", [input.id, input.externalIdentityId, input.status, input.dnsRecords]) : query<RepositoryRows.SaveCreatedIdentityRow>("UPDATE provider_identities SET external_identity_id=$2,status=CASE WHEN status='disabled' THEN status ELSE $3 END,dns_records=$4,last_checked_at=now(),updated_at=now() WHERE id=$1 RETURNING status", [input.id, input.externalIdentityId, input.status, input.dnsRecords]);
    },
    saveIdentityVerification(input: { id: string; status: string; dnsRecords: string }) {
      return client ? client.query<RepositoryRows.SaveIdentityVerificationRow>("UPDATE provider_identities SET status=$2,dns_records=$3,last_checked_at=now(),updated_at=now() WHERE id=$1 AND status<>'disabled'", [input.id, input.status, input.dnsRecords]) : query<RepositoryRows.SaveIdentityVerificationRow>("UPDATE provider_identities SET status=$2,dns_records=$3,last_checked_at=now(),updated_at=now() WHERE id=$1 AND status<>'disabled'", [input.id, input.status, input.dnsRecords]);
    },
    findIdentityProviderType(input: { id: string }) {
      return client ? client.query<RepositoryRows.FindIdentityProviderTypeRow>(`SELECT pa.type FROM provider_identities pi
    JOIN provider_accounts pa ON pa.id=pi.provider_account_id WHERE pi.id=$1`, [input.id]) : query<RepositoryRows.FindIdentityProviderTypeRow>(`SELECT pa.type FROM provider_identities pi
    JOIN provider_accounts pa ON pa.id=pi.provider_account_id WHERE pi.id=$1`, [input.id]);
    },
    setIdentityStatus(input: { id: string; status: string }) {
      return client ? client.query<RepositoryRows.SetIdentityStatusRow>("UPDATE provider_identities SET status=$2,archived_at=CASE WHEN $2='disabled' THEN archived_at ELSE NULL END,sync_after=clock_timestamp(),sync_lease_until=NULL,sync_lease_token=NULL,updated_at=clock_timestamp() WHERE id=$1", [input.id, input.status]) : query<RepositoryRows.SetIdentityStatusRow>("UPDATE provider_identities SET status=$2,archived_at=CASE WHEN $2='disabled' THEN archived_at ELSE NULL END,sync_after=clock_timestamp(),sync_lease_until=NULL,sync_lease_token=NULL,updated_at=clock_timestamp() WHERE id=$1", [input.id, input.status]);
    }
  };
}

export const managementRepository = createManagementRepository();
export const managementUnitOfWork: ManagementUnitOfWork = { run: work => transaction(client => work(createManagementRepository(client))) };
