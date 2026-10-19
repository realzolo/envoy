export interface RepositoryResult<Row> { rows:Row[];rowCount:number|null; }
export interface ManagementRepository {
  setServiceStatus(input:{id:string;status:"active"|"suspended"}):Promise<RepositoryResult<never>>;
  recordAudit(input:{actor:string;action:string;resourceType:string;resourceId:null|string;details:unknown}):Promise<RepositoryResult<RecordAuditRow>>;
  lockActiveCredential(input:{id:string}):Promise<RepositoryResult<LockActiveCredentialRow>>;
  limitCredentialOverlap(input:{id:string}):Promise<RepositoryResult<LimitCredentialOverlapRow>>;
  insertRotatedCredential(input:{id:string;serviceId:string;keyPrefix:string;keyHash:string}):Promise<RepositoryResult<InsertRotatedCredentialRow>>;
  recordCredentialRotation(input:{actor:string;resourceId:string;details:unknown}):Promise<RepositoryResult<RecordCredentialRotationRow>>;
  revokeCredential(input:{id:string}):Promise<RepositoryResult<RevokeCredentialRow>>;
  findRegisteredDomains(input:{selectedIds:string[]}):Promise<RepositoryResult<FindRegisteredDomainsRow>>;
  findProviderIdentities(input:{identityIds:string[]}):Promise<RepositoryResult<FindProviderIdentityRow>>;
  deleteServiceBindings(input:{serviceId:string}):Promise<RepositoryResult<never>>;
  insertServiceBinding(input:{id:string;serviceId:string;domainId:string;receive:boolean;outboundIdentityId:string|null}):Promise<RepositoryResult<never>>;
  lockServiceCallback(input:{serviceId:string}):Promise<RepositoryResult<LockServiceCallbackRow>>;
  saveServiceCallback(input:{id:string;name:string;url:null|string;status:string}):Promise<RepositoryResult<SaveServiceCallbackRow>>;
  stopPendingCallbackDeliveries(input:{endpointId:string}):Promise<RepositoryResult<StopPendingCallbackDeliveriesRow>>;
  insertServiceCallback(input:{id:string;serviceId:string;name:string;url:string;secretCiphertext:string;encryptedDek:string;keyVersion:string;subscribedEvents:string[]}):Promise<RepositoryResult<InsertServiceCallbackRow>>;
  insertServiceCredential(input:{id:string;serviceId:string;keyPrefix:string;keyHash:string}):Promise<RepositoryResult<InsertServiceCredentialRow>>;
  recordCredentialIssue(input:{actor:string;resourceId:string;details:unknown}):Promise<RepositoryResult<RecordCredentialIssueRow>>;
  insertService(input:{id:string;name:string;suppressionManagementAllowed:boolean}):Promise<RepositoryResult<InsertServiceRow>>;
  recordServiceCreation(input:{actor:string;resourceId:string;details:unknown}):Promise<RepositoryResult<RecordServiceCreationRow>>;
  lockServiceConfiguration(input:{id:string}):Promise<RepositoryResult<LockServiceConfigurationRow>>;
  findServiceBindings(input:{serviceId:string}):Promise<RepositoryResult<FindServiceBindingRow>>;
  findServiceCallback(input:{serviceId:string}):Promise<RepositoryResult<FindServiceCallbackRow>>;
  updateServiceConfiguration(input:{id:string;name:string;suppressionManagementAllowed:boolean}):Promise<RepositoryResult<UpdateServiceConfigurationRow>>;
  recordServiceUpdate(input:{actor:string;resourceId:string;details:unknown}):Promise<RepositoryResult<RecordServiceUpdateRow>>;
  lockActiveService(input:{id:string}):Promise<RepositoryResult<LockActiveServiceRow>>;
  queuePermissionsChanged(serviceId:string):Promise<void>;
}
export interface ManagementUnitOfWork { run<T>(work:(repository:ManagementRepository)=>Promise<T>):Promise<T>; }

export type RecordAuditRow=never;
export type LockActiveCredentialRow={ service_id: string };
export type LimitCredentialOverlapRow={valid_to:Date};
export type InsertRotatedCredentialRow=never;
export type RecordCredentialRotationRow=never;
export type RevokeCredentialRow=never;
export type FindRegisteredDomainsRow={id:string};
export type FindProviderIdentityRow={id:string;sending_domain_id:string};
export type LockServiceCallbackRow={ id: string; url: string | null; status: string };
export type SaveServiceCallbackRow=never;
export type StopPendingCallbackDeliveriesRow=never;
export type InsertServiceCallbackRow=never;
export type InsertServiceCredentialRow=never;
export type RecordCredentialIssueRow=never;
export type InsertServiceRow=never;
export type RecordServiceCreationRow=never;
export type LockServiceConfigurationRow={id:string;status:string;name:string;suppression_management_allowed:boolean;configuration_revision:number;created_at:Date;updated_at:Date};
export type FindServiceBindingRow={sending_domain_id:string;receive_enabled:boolean;outbound_provider_identity_id:string|null};
export type FindServiceCallbackRow={url:string|null;status:string};
export type UpdateServiceConfigurationRow=never;
export type RecordServiceUpdateRow=never;
export type LockActiveServiceRow=never;
