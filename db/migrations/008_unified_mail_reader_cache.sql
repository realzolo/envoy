SET LOCAL lock_timeout = '30s';
CREATE TABLE mail_reader_resources (
 source_kind text NOT NULL, source_id text NOT NULL, source_revision text NOT NULL, resource_id text NOT NULL,
 service_id text, state text DEFAULT 'PENDING' NOT NULL, reason_code text, cached_content jsonb, content_type text,
 size_bytes bigint, sha256 text, attempt_count integer DEFAULT 0 NOT NULL, available_at timestamptz DEFAULT now() NOT NULL,
 lease_token text, lease_expires_at timestamptz, created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
 PRIMARY KEY(source_kind,source_id,source_revision,resource_id),
 CONSTRAINT mail_reader_source_kind CHECK(source_kind IN ('INBOUND','OUTBOUND')),
 CONSTRAINT mail_reader_state CHECK(state IN ('PENDING','RUNNING','READY','RETRY_WAIT','UNAVAILABLE')),
 CONSTRAINT mail_reader_size CHECK(size_bytes IS NULL OR (size_bytes > 0 AND size_bytes <= 20000000)),
 CONSTRAINT mail_reader_ready CHECK(state <> 'READY' OR (cached_content IS NOT NULL AND content_type IS NOT NULL AND size_bytes IS NOT NULL AND sha256 ~ '^[a-f0-9]{64}$'))
);
CREATE INDEX mail_reader_resource_work ON mail_reader_resources(state,available_at);
CREATE FUNCTION erase_mail_reader_resources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.content_purged_at IS NOT NULL THEN
   IF TG_TABLE_NAME='inbound_messages' THEN
     DELETE FROM mail_reader_resources WHERE source_kind='INBOUND' AND source_id=OLD.id;
   ELSE
     DELETE FROM mail_reader_resources WHERE source_kind='OUTBOUND' AND source_id IN (SELECT id FROM deliveries WHERE message_id=OLD.id);
   END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER inbound_reader_erasure BEFORE DELETE OR UPDATE ON inbound_messages FOR EACH ROW EXECUTE FUNCTION erase_mail_reader_resources();
CREATE TRIGGER outbound_reader_erasure BEFORE DELETE OR UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION erase_mail_reader_resources();
CREATE FUNCTION erase_delivery_reader_resources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM mail_reader_resources WHERE source_kind='OUTBOUND' AND source_id=OLD.id;
 RETURN OLD;
END $$;
CREATE TRIGGER delivery_reader_erasure BEFORE DELETE ON deliveries FOR EACH ROW EXECUTE FUNCTION erase_delivery_reader_resources();

COMMENT ON TABLE "mail_reader_resources" IS 'Unified versioned mail reader resource cache and bounded preparation jobs; erased with the retained parent source';
COMMENT ON COLUMN "mail_reader_resources"."source_kind" IS 'Source adapter: INBOUND or OUTBOUND';
COMMENT ON COLUMN "mail_reader_resources"."source_id" IS 'Inbound message ID or outbound delivery ID';
COMMENT ON COLUMN "mail_reader_resources"."source_revision" IS 'SHA-256 of original source and reader policy';
COMMENT ON COLUMN "mail_reader_resources"."resource_id" IS 'Stable resource identity within one reader source revision';
COMMENT ON COLUMN "mail_reader_resources"."service_id" IS 'Requesting Service scope; null is an explicitly authenticated admin request';
COMMENT ON COLUMN "mail_reader_resources"."state" IS 'Preparation state: PENDING, RUNNING, READY, RETRY_WAIT or UNAVAILABLE';
COMMENT ON COLUMN "mail_reader_resources"."reason_code" IS 'Content-free preparation outcome code';
COMMENT ON COLUMN "mail_reader_resources"."cached_content" IS 'Envelope-encrypted verified original image bytes';
COMMENT ON COLUMN "mail_reader_resources"."content_type" IS 'Verified original image MIME type';
COMMENT ON COLUMN "mail_reader_resources"."size_bytes" IS 'Verified image size with a 20000000 byte ceiling';
COMMENT ON COLUMN "mail_reader_resources"."sha256" IS 'Verified SHA-256 of image bytes';
COMMENT ON COLUMN "mail_reader_resources"."attempt_count" IS 'Actual preparation attempts consumed in the bounded retry budget';
COMMENT ON COLUMN "mail_reader_resources"."available_at" IS 'Earliest next preparation time';
COMMENT ON COLUMN "mail_reader_resources"."lease_token" IS 'Exclusive resource preparation token';
COMMENT ON COLUMN "mail_reader_resources"."lease_expires_at" IS 'Preparation lease expiry';
COMMENT ON COLUMN "mail_reader_resources"."created_at" IS 'Record creation time (timestamptz); defaults to the database transaction start time, now()';
COMMENT ON COLUMN "mail_reader_resources"."updated_at" IS 'Last update time (timestamptz); explicitly maintained by business writes, defaults to now()';

-- The former V1 resource preparer is retired. Retain source/metadata facts, never its second media cache or leases.
UPDATE inbound_document_resources SET cached_content=NULL,sha256=NULL,scan_policy=NULL,lease_token=NULL,lease_expires_at=NULL,
 state=CASE WHEN metadata->>'kind' IN ('REMOTE','EMBEDDED') AND state='READY' THEN 'PREPARING' ELSE state END,
 reason_code=CASE WHEN metadata->>'kind' IN ('REMOTE','EMBEDDED') AND state='READY' THEN 'NOT_READY' ELSE reason_code END
WHERE cached_content IS NOT NULL OR sha256 IS NOT NULL OR scan_policy IS NOT NULL OR lease_token IS NOT NULL OR lease_expires_at IS NOT NULL OR (state='READY' AND metadata->>'kind' IN ('REMOTE','EMBEDDED'));
