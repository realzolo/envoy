import { createManagementService } from './application/management';
import { managementRepository,managementUnitOfWork } from './infrastructure/management.repository';
import { loadProviderAccount } from './infrastructure/provider-account';
export const {createProviderAccount,testProviderAccount,toggleProvider,updateProviderQuota,rotateProviderCredential,configureProviderWebhook,toggleWebhookEndpoint,createDomain,setDomainInboundSources,toggleDomain,refreshIdentity,toggleIdentity}=createManagementService(managementRepository,managementUnitOfWork,{loadProviderAccount});
export { channelsAdminReads } from './infrastructure/admin.read-repository';
export { loadWebhookEndpoint } from './infrastructure/webhook-endpoint';
export { loadProviderAccount };
