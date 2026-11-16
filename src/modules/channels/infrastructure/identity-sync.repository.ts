import { query } from '@/platform/database';
import type { IdentitySyncRepository } from '../application/identity-sync';

export const identitySyncRepository: IdentitySyncRepository = {
  async claim(token) {
    const result = await query<{ id: string; accountId: string; failures: number; token: string }>(`WITH candidate AS (
      SELECT pi.id FROM provider_identities pi
      JOIN sending_domains d ON d.id=pi.sending_domain_id
      JOIN provider_accounts a ON a.id=pi.provider_account_id
      WHERE a.type='resend' AND a.status='active' AND d.status='active'
        AND d.archived_at IS NULL AND pi.archived_at IS NULL AND pi.status<>'disabled'
        AND pi.sync_after<=clock_timestamp()
        AND (pi.sync_lease_until IS NULL OR pi.sync_lease_until<=clock_timestamp())
        AND EXISTS(SELECT 1 FROM provider_credentials c WHERE c.provider_account_id=a.id
          AND c.status='active' AND c.valid_from<=now() AND (c.valid_to IS NULL OR c.valid_to>now()))
      ORDER BY pi.sync_after,pi.id LIMIT 1 FOR UPDATE OF pi SKIP LOCKED
    ) UPDATE provider_identities pi SET sync_lease_token=$1,
      sync_lease_until=clock_timestamp()+interval '2 minutes',sync_attempt_at=clock_timestamp()
      FROM candidate WHERE pi.id=candidate.id
      RETURNING pi.id,pi.provider_account_id AS "accountId",pi.sync_failures AS failures,pi.sync_lease_token AS token`,[token]);
    return result.rows[0] ?? null;
  },
  async finish(input) {
    await query(`UPDATE provider_identities SET sync_after=clock_timestamp()+$3*interval '1 second',
      sync_failures=CASE WHEN $6 THEN sync_failures WHEN $4 THEN LEAST(sync_failures+1,100) ELSE 0 END,
      sync_error=CASE WHEN $6 THEN sync_error ELSE $5 END,
      sync_lease_until=NULL,sync_lease_token=NULL
      WHERE id=$1 AND sync_lease_token=$2 AND sync_lease_until>clock_timestamp()`,
      [input.id,input.token,input.delaySeconds,input.failed,input.error,input.deferred ?? false]);
  },
};
