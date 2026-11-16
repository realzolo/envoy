export type IdentitySyncClaim = { id: string; accountId: string; failures: number; token: string };
export interface IdentitySyncRepository {
  claim(token: string): Promise<IdentitySyncClaim | null>;
  finish(input: { id: string; token: string; delaySeconds: number; failed: boolean; deferred?: boolean; error: string | null }): Promise<void>;
}
export interface IdentitySyncDependencies {
  repository: IdentitySyncRepository;
  token(): string;
  allowAccount(accountId: string): Promise<boolean>;
  refresh(id: string, token: string): Promise<{ status: string }>;
}

/** Keep errors content-free: upstream messages may contain credentials or private values. */
export function identitySyncFailure(error: unknown) {
  const code = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 0;
  if (code === 401 || code === 403) return 'Provider authentication or domain permissions failed. Check this provider account.';
  if (code === 429) return 'Provider rate limit reached. Sync will retry automatically.';
  if (code >= 500) return 'Provider temporarily unavailable. Sync will retry automatically.';
  return 'Provider sync failed. Check the account and domain binding, or sync manually for details.';
}

export function identitySyncDelay(failures: number, error: unknown) {
  const rateLimited = error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 429;
  const retryAfter = error && typeof error === 'object' && 'retryAfterSeconds' in error ? Number(error.retryAfterSeconds) : 0;
  const delay = Math.min(3600, Math.max(rateLimited ? 300 : 60, 60 * 2 ** Math.min(6, Math.max(0, failures))));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(delay, Math.min(31_536_000, Math.ceil(retryAfter))) : delay;
}

export function createIdentitySyncService(dependencies: IdentitySyncDependencies) {
  return async function syncProviderIdentities(limit = 5) {
    const count = Number.isFinite(limit) ? Math.min(20, Math.max(1, Math.floor(limit))) : 5;
    let synced = 0;
    for (let index = 0; index < count; index++) {
      const claim = await dependencies.repository.claim(dependencies.token());
      if (!claim) break;
      let delaySeconds = 60, failed = false, deferred = false, error: string | null = null;
      try {
        if (!await dependencies.allowAccount(claim.accountId)) {
          delaySeconds = 10;
          deferred = true;
        } else {
          const result = await dependencies.refresh(claim.id, claim.token);
          delaySeconds = result.status === 'verified' ? 6 * 3600 : 60;
          synced++;
        }
      } catch (failure) {
        failed = true;
        error = identitySyncFailure(failure);
        delaySeconds = identitySyncDelay(claim.failures, failure);
      }
      // Token fencing also makes a delayed completion harmless after lease reclamation.
      await dependencies.repository.finish({id:claim.id,token:claim.token,delaySeconds,failed,deferred,error});
    }
    return {synced};
  };
}
