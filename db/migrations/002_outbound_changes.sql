-- Committed Service-scoped outbound event references.
SET LOCAL lock_timeout = '5s';
LOCK TABLE delivery_events, submission_events IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE "outbound_changes" (
	"service_id" text NOT NULL,
	"position" bigint NOT NULL,
	"id" text NOT NULL,
	"message_id" text NOT NULL,
	"type" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "outbound_changes_service_id_position_pk" PRIMARY KEY("service_id","position"),
	CONSTRAINT "outbound_changes_id_unique" UNIQUE("id")
);

CREATE TABLE "outbound_streams" (
	"service_id" text PRIMARY KEY NOT NULL,
	"generation" uuid DEFAULT gen_random_uuid() NOT NULL,
	"position" bigint DEFAULT 0 NOT NULL,
	"floor" bigint DEFAULT 0 NOT NULL
);

ALTER TABLE "outbound_changes" ADD CONSTRAINT "outbound_changes_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "outbound_changes" ADD CONSTRAINT "outbound_changes_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "outbound_streams" ADD CONSTRAINT "outbound_streams_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
CREATE FUNCTION record_outbound_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_service text; owner_message text; next_position bigint;
BEGIN
  IF TG_TABLE_NAME='delivery_events' THEN
    SELECT m.service_id,m.id INTO owner_service,owner_message FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE d.id=NEW.delivery_id;
  ELSE
    SELECT m.service_id,m.id INTO owner_service,owner_message FROM messages m JOIN submissions s ON s.message_id=m.id WHERE s.id=NEW.submission_id;
  END IF;
  INSERT INTO outbound_streams(service_id) VALUES(owner_service) ON CONFLICT DO NOTHING;
  UPDATE outbound_streams SET position=position+1 WHERE service_id=owner_service RETURNING position INTO next_position;
  INSERT INTO outbound_changes(service_id,position,id,message_id,type) VALUES(owner_service,next_position,NEW.id,owner_message,NEW.event_type);
  RETURN NEW;
END $$;

WITH facts AS (
  SELECT m.service_id,m.id AS message_id,de.id,de.event_type,de.created_at FROM delivery_events de JOIN deliveries d ON d.id=de.delivery_id JOIN messages m ON m.id=d.message_id
  UNION ALL
  SELECT m.service_id,m.id,se.id,se.event_type,se.created_at FROM submission_events se JOIN submissions s ON s.id=se.submission_id JOIN messages m ON m.id=s.message_id
)
INSERT INTO outbound_changes(service_id,position,id,message_id,type)
  SELECT service_id,row_number() OVER(PARTITION BY service_id ORDER BY created_at,id),id,message_id,event_type FROM facts;
INSERT INTO outbound_streams(service_id,position)
  SELECT service_id,max(position) FROM outbound_changes GROUP BY service_id;

CREATE TRIGGER outbound_delivery_change AFTER INSERT ON delivery_events FOR EACH ROW EXECUTE FUNCTION record_outbound_change();
CREATE TRIGGER outbound_submission_change AFTER INSERT ON submission_events FOR EACH ROW EXECUTE FUNCTION record_outbound_change();

COMMENT ON TABLE "outbound_changes" IS 'Content-free committed outbound event references for incremental reconciliation';
COMMENT ON COLUMN "outbound_changes"."service_id" IS 'Owning Service; composite primary key with position';
COMMENT ON COLUMN "outbound_changes"."position" IS 'Per-Service committed stream position independent of provider occurrence time';
COMMENT ON COLUMN "outbound_changes"."id" IS 'Canonical delivery or submission event identifier';
COMMENT ON COLUMN "outbound_changes"."message_id" IS 'Owning outbound message';
COMMENT ON COLUMN "outbound_changes"."type" IS 'Canonical event type';
COMMENT ON COLUMN "outbound_changes"."recorded_at" IS 'Local insertion time used for 90-day prefix retention';
COMMENT ON TABLE "outbound_streams" IS 'Service-owned committed outbound change prefix and retention boundary';
COMMENT ON COLUMN "outbound_streams"."service_id" IS 'Owning Service and primary key';
COMMENT ON COLUMN "outbound_streams"."generation" IS 'Stream identity rejecting cursors from replaced streams';
COMMENT ON COLUMN "outbound_streams"."position" IS 'Latest per-Service bigint position allocated under a transaction row lock';
COMMENT ON COLUMN "outbound_streams"."floor" IS 'Last removed prefix position; cursors below it require reconciliation';
