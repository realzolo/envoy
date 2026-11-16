ALTER TABLE sending_domains ADD COLUMN archived_at timestamptz;
ALTER TABLE provider_identities
 ADD COLUMN archived_at timestamptz,
 ADD COLUMN sync_after timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN sync_lease_until timestamptz,
 ADD COLUMN sync_lease_token text,
 ADD COLUMN sync_failures integer NOT NULL DEFAULT 0,
 ADD COLUMN sync_attempt_at timestamptz,
 ADD COLUMN sync_error text,
 ADD CONSTRAINT provider_identities_sync_failures_check CHECK (sync_failures >= 0);
COMMENT ON COLUMN "sending_domains"."archived_at" IS 'Archive timestamp; restoration does not restore Service grants';
COMMENT ON COLUMN "provider_identities"."archived_at" IS 'Archive timestamp; archived identities remain disabled';
COMMENT ON COLUMN "provider_identities"."sync_after" IS 'Next scheduled provider synchronization time';
COMMENT ON COLUMN "provider_identities"."sync_lease_until" IS 'Background synchronization lease expiry';
COMMENT ON COLUMN "provider_identities"."sync_lease_token" IS 'Fence for the current background synchronization lease';
COMMENT ON COLUMN "provider_identities"."sync_failures" IS 'Consecutive background synchronization failures for retry backoff';
COMMENT ON COLUMN "provider_identities"."sync_attempt_at" IS 'Last synchronization attempt timestamp';
COMMENT ON COLUMN "provider_identities"."sync_error" IS 'Content-free synchronization failure summary; null after success';
