-- Versioned passive inbound reading projections. Existing copies remain revision zero until explicit reprojection.
ALTER TABLE inbound_messages ADD COLUMN document_revision bigint DEFAULT 0 NOT NULL, ADD COLUMN document_projection jsonb, ADD COLUMN document_source jsonb;


CREATE TABLE "inbound_document_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"inbound_message_id" text NOT NULL,
	"document_revision" bigint NOT NULL,
	"metadata" jsonb NOT NULL,
	"source" jsonb,
	"cached_content" jsonb,
	"content_type" text,
	"size_bytes" bigint,
	"sha256" text,
	"scan_policy" text,
	"state" text NOT NULL,
	"reason_code" text,
	"attempt_count" bigint DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_document_resource_size" CHECK (size_bytes IS NULL OR (size_bytes >= 0 AND size_bytes <= 5000000)),
	CONSTRAINT "inbound_document_resource_state" CHECK (state IN ('READY','PREPARING','RETRYABLE','BLOCKED','UNAVAILABLE','ERASED'))
);

ALTER TABLE "inbound_document_resources" ADD CONSTRAINT "inbound_document_resources_inbound_message_id_inbound_messages_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."inbound_messages"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "inbound_document_resources_message" ON "inbound_document_resources" USING btree ("inbound_message_id","document_revision");

CREATE FUNCTION erase_inbound_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_purged_at IS NOT NULL THEN
    NEW.document_source := NULL; NEW.document_projection := NULL;
    NEW.sanitized_html := NULL; NEW.text_body := NULL;
    UPDATE inbound_document_resources SET source=NULL,cached_content=NULL,metadata=metadata || jsonb_build_object('contentId',NULL),state='ERASED',reason_code='CONTENT_ERASED',lease_token=NULL,lease_expires_at=NULL WHERE inbound_message_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inbound_document_purge BEFORE UPDATE ON inbound_messages FOR EACH ROW EXECUTE FUNCTION erase_inbound_document();

COMMENT ON TABLE "inbound_document_resources" IS 'Private versioned inbound bitmap resources; source and cache are envelope encrypted and erased with their parent message';

COMMENT ON COLUMN "inbound_document_resources"."id" IS 'Unpredictable resource identity scoped to one inbound document revision';

COMMENT ON COLUMN "inbound_document_resources"."inbound_message_id" IS 'Original private inbound message owner';

COMMENT ON COLUMN "inbound_document_resources"."document_revision" IS 'Frozen owning document revision';

COMMENT ON COLUMN "inbound_document_resources"."metadata" IS 'Safe kind and MIME attachment identity, without source URL';

COMMENT ON COLUMN "inbound_document_resources"."source" IS 'Envelope-encrypted original image URL or explicit embedded bitmap';

COMMENT ON COLUMN "inbound_document_resources"."cached_content" IS 'Envelope-encrypted verified bitmap bytes';

COMMENT ON COLUMN "inbound_document_resources"."content_type" IS 'Byte-verified raster MIME type';

COMMENT ON COLUMN "inbound_document_resources"."size_bytes" IS 'Verified bitmap size, limited to 5000000 bytes';

COMMENT ON COLUMN "inbound_document_resources"."sha256" IS 'Verified byte digest';

COMMENT ON COLUMN "inbound_document_resources"."scan_policy" IS 'Scanner configuration policy used for the cached bitmap';

COMMENT ON COLUMN "inbound_document_resources"."state" IS 'Finite preparation/read state';

COMMENT ON COLUMN "inbound_document_resources"."reason_code" IS 'Finite content-free preparation reason';

COMMENT ON COLUMN "inbound_document_resources"."attempt_count" IS 'Bounded preparation attempts';

COMMENT ON COLUMN "inbound_document_resources"."available_at" IS 'Earliest preparation retry time';

COMMENT ON COLUMN "inbound_document_resources"."lease_token" IS 'Exclusive preparation claim';

COMMENT ON COLUMN "inbound_document_resources"."lease_expires_at" IS 'Preparation claim deadline';

COMMENT ON COLUMN "inbound_document_resources"."created_at" IS 'Resource registration time';

COMMENT ON COLUMN "inbound_messages"."document_revision" IS 'Monotonic reading projection revision, zero for unprojected legacy copies';

COMMENT ON COLUMN "inbound_messages"."document_projection" IS 'Passive document metadata and resource identities; never resource source URLs';

COMMENT ON COLUMN "inbound_messages"."document_source" IS 'Envelope-encrypted canonical authored body retained under the original inbound lifetime';
