import type { ProviderType } from '@/integrations/providers/contracts';
export interface RepositoryResult<Row> { rows:Row[];rowCount:number|null; }
export interface ManagementRepository {
  recordAudit(input:{actor:string;action:string;resourceType:string;resourceId:null|string;details:unknown}):Promise<RepositoryResult<RecordAuditRow>>;
  insertProviderAccount(input:{id:string;type:string;name:string;publicConfig:unknown}):Promise<RepositoryResult<InsertProviderAccountRow>>;
  insertInitialCredential(input:{id:string;providerAccountId:string;secretCiphertext:string;encryptedDek:string;keyVersion:string;createdBy:string}):Promise<RepositoryResult<InsertInitialCredentialRow>>;
  insertWebhookEndpoint(input:{id:string;providerAccountId:string;opaqueToken:string}):Promise<RepositoryResult<InsertWebhookEndpointRow>>;
  recordAccountCreation(input:{actor:string;resourceId:string;details:unknown}):Promise<RepositoryResult<RecordAccountCreationRow>>;
  findActiveCredentialVersion(input:{providerAccountId:string}):Promise<RepositoryResult<FindActiveCredentialVersionRow>>;
  lockProviderAccount(input:{id:string}):Promise<RepositoryResult<LockProviderAccountRow>>;
  saveCredentialHealth(input:{id:string;healthy:boolean;health:unknown;credentialVersion:number}):Promise<RepositoryResult<SaveCredentialHealthRow>>;
  recordHealthCheck(input:{actor:string;resourceId:string;details:unknown}):Promise<RepositoryResult<RecordHealthCheckRow>>;
  setProviderAccountStatus(input:{id:string;status:string}):Promise<RepositoryResult<SetProviderAccountStatusRow>>;
  saveProviderQuota(input:{id:string;quota:unknown}):Promise<RepositoryResult<SaveProviderQuotaRow>>;
  recordQuotaUpdate(input:{actor:string;resourceId:string;details:unknown}):Promise<RepositoryResult<RecordQuotaUpdateRow>>;
  findProviderType(input:{id:string}):Promise<RepositoryResult<FindProviderTypeRow>>;
  lockCredentialAccount(input:{id:string}):Promise<RepositoryResult<LockCredentialAccountRow>>;
  findLatestCredentialVersion(input:{providerAccountId:string}):Promise<RepositoryResult<FindLatestCredentialVersionRow>>;
  revokeActiveCredentials(input:{providerAccountId:string}):Promise<RepositoryResult<RevokeActiveCredentialsRow>>;
  insertProviderCredential(input:{id:string;providerAccountId:string;credentialVersion:number;secretCiphertext:string;encryptedDek:string;keyVersion:string;createdBy:string}):Promise<RepositoryResult<InsertProviderCredentialRow>>;
  invalidateCredentialHealth(input:{id:string;health:unknown}):Promise<RepositoryResult<InvalidateCredentialHealthRow>>;
  recordCredentialRotation(input:{actor:string;resourceId:string;details:unknown}):Promise<RepositoryResult<RecordCredentialRotationRow>>;
  lockWebhookSecurity(input:{id:string}):Promise<RepositoryResult<LockWebhookSecurityRow>>;
  saveWebhookSecurity(input:{id:string;securityConfigCiphertext:unknown;securityEncryptedDek:unknown;keyVersion:string;securityVersion:number;expectedTopicArn:null|string;ipAllowlist:unknown[]}):Promise<RepositoryResult<SaveWebhookSecurityRow>>;
  recordWebhookSecurityUpdate(input:{actor:string;resourceId:string;details:unknown}):Promise<RepositoryResult<RecordWebhookSecurityUpdateRow>>;
  setWebhookStatus(input:{id:string;status:string}):Promise<RepositoryResult<SetWebhookStatusRow>>;
  insertDomain(input:{id:string;domain:string}):Promise<RepositoryResult<InsertDomainRow>>;
  findDomainByName(input:{domain:string}):Promise<RepositoryResult<FindDomainByNameRow>>;
  findReadyInboundAccounts():Promise<RepositoryResult<FindReadyInboundAccountRow>>;
  findProviderAccountIds(input:{accountIds:string[]}):Promise<RepositoryResult<FindProviderAccountIdRow>>;
  insertDomainInboundSource(input:{domainId:string;accountId:string}):Promise<RepositoryResult<never>>;
  replaceDomainInboundSources(input:{domainId:string;accountIds:string[]}):Promise<RepositoryResult<never>>;
  lockDomain(input:{id:string}):Promise<RepositoryResult<LockDomainRow>>;
  notifyDomainBindingsChanged(input:{domainId:string;receiveOnly:boolean}):Promise<void>;
  findDomainIdentity(input:{sendingDomainId:string;providerAccountId:string}):Promise<RepositoryResult<FindDomainIdentityRow>>;
  insertDashboardIdentity(input:{id:string;sendingDomainId:string;providerAccountId:string}):Promise<RepositoryResult<InsertDashboardIdentityRow>>;
  insertManagedIdentity(input:{id:string;sendingDomainId:string;providerAccountId:string;externalIdentityId:string;status:string;dnsRecords:string}):Promise<RepositoryResult<InsertManagedIdentityRow>>;
  insertFailedIdentity(input:{id:string;sendingDomainId:string;providerAccountId:string}):Promise<RepositoryResult<InsertFailedIdentityRow>>;
  setDomainStatus(input:{id:string;status:string}):Promise<RepositoryResult<SetDomainStatusRow>>;
  findIdentityAccount(input:{id:string}):Promise<RepositoryResult<FindIdentityAccountRow>>;
  saveCreatedIdentity(input:{id:string;externalIdentityId:string;status:string;dnsRecords:string}):Promise<RepositoryResult<SaveCreatedIdentityRow>>;
  saveIdentityVerification(input:{id:string;status:string;dnsRecords:string}):Promise<RepositoryResult<SaveIdentityVerificationRow>>;
  findIdentityProviderType(input:{id:string}):Promise<RepositoryResult<FindIdentityProviderTypeRow>>;
  setIdentityStatus(input:{id:string;status:string}):Promise<RepositoryResult<SetIdentityStatusRow>>;
}
export interface ManagementUnitOfWork { run<T>(work:(repository:ManagementRepository)=>Promise<T>):Promise<T>; }

import type { ProviderModule,ProviderSendContext } from '@/integrations/providers/contracts';
export interface ChannelDependencies {loadProviderAccount(id:string,options?:{allowNonActive?:boolean}):Promise<{module:ProviderModule;context:ProviderSendContext}>;}

export type RecordAuditRow=never;
export type InsertProviderAccountRow=never;
export type InsertInitialCredentialRow=never;
export type InsertWebhookEndpointRow=never;
export type RecordAccountCreationRow=never;
export type FindActiveCredentialVersionRow={ credential_version: number };
export type LockProviderAccountRow=never;
export type SaveCredentialHealthRow=never;
export type RecordHealthCheckRow=never;
export type SetProviderAccountStatusRow=never;
export type SaveProviderQuotaRow=never;
export type RecordQuotaUpdateRow=never;
export type FindProviderTypeRow={ type: ProviderType };
export type LockCredentialAccountRow=never;
export type FindLatestCredentialVersionRow={
      credential_version: number
    };
export type RevokeActiveCredentialsRow=never;
export type InsertProviderCredentialRow=never;
export type InvalidateCredentialHealthRow=never;
export type RecordCredentialRotationRow=never;
export type LockWebhookSecurityRow={
      security_version: number;
      type: ProviderType
    };
export type SaveWebhookSecurityRow=never;
export type RecordWebhookSecurityUpdateRow=never;
export type SetWebhookStatusRow=never;
export type InsertDomainRow={ id: string };
export type FindDomainByNameRow={ id: string };
export type FindReadyInboundAccountRow={ id:string };
export type FindProviderAccountIdRow={ id:string };
export type LockDomainRow={ id:string;status:string };
export type FindDomainIdentityRow={ id: string; status: string };
export type InsertDashboardIdentityRow=never;
export type InsertManagedIdentityRow=never;
export type InsertFailedIdentityRow=never;
export type SetDomainStatusRow=never;
export type FindIdentityAccountRow={
    provider_account_id: string;
    external_identity_id: string | null;
    domain: string;
    status: string;
  };
export type SaveCreatedIdentityRow={ status: string };
export type SaveIdentityVerificationRow=never;
export type FindIdentityProviderTypeRow={ type: ProviderType };
export type SetIdentityStatusRow=never;
