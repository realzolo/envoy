import { createManagementService } from './application/management';
import { managementRepository, managementUnitOfWork } from './infrastructure/management.repository';
import { loadProviderAccount } from './infrastructure/provider-account';
import { createIdentitySyncService } from './application/identity-sync';
import { identitySyncRepository } from './infrastructure/identity-sync.repository';
import { enforceScopedRateLimit } from '@/platform/runtime-store';
import { randomUUID } from 'node:crypto';

export const {
  createProviderAccount,
  testProviderAccount,
  toggleProvider,
  updateProviderQuota,
  rotateProviderCredential,
  configureProviderWebhook,
  toggleWebhookEndpoint,
  createDomain,
  setDomainInboundSources,
  toggleDomain,
  refreshIdentity,
  verifyIdentity,
  deleteDomain,
  deleteIdentity,
  archiveDomain,
  archiveIdentity,
  toggleIdentity
} = createManagementService(managementRepository, managementUnitOfWork, { loadProviderAccount });
export { channelsAdminReads } from './infrastructure/admin.read-repository';
export { loadWebhookEndpoint } from './infrastructure/webhook-endpoint';
export { loadProviderAccount };

export const syncProviderIdentities = createIdentitySyncService({
  repository: identitySyncRepository,
  token: randomUUID,
  allowAccount: accountId => enforceScopedRateLimit('provider-identity-sync', accountId, 1, 10),
  refresh: (id, token) => refreshIdentity(id, 'system:provider-identity-sync', false, token),
});
