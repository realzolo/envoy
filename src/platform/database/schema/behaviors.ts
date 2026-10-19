/** Native PostgreSQL invariants included in the generated schema snapshot. */
export const databaseBehaviors = String.raw`-- Database-enforced inbound change ordering and attachment purge fencing.

CREATE FUNCTION record_inbound_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE change_type text; next_position bigint;
BEGIN
  IF NEW.service_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.content_purged_at IS NOT NULL AND OLD.content_purged_at IS NULL THEN
    change_type := 'inbound.content_purged';
  ELSIF NEW.status='ready' AND OLD.status<>'ready' AND NEW.content_purged_at IS NULL THEN
    change_type := 'inbound.available';
  ELSE RETURN NEW;
  END IF;
  INSERT INTO inbound_streams(service_id) VALUES(NEW.service_id) ON CONFLICT DO NOTHING;
  UPDATE inbound_streams SET position=position+1 WHERE service_id=NEW.service_id RETURNING position INTO next_position;
  INSERT INTO inbound_changes(service_id,position,inbound_message_id,type)
    VALUES(NEW.service_id,next_position,NEW.id,change_type);
  RETURN NEW;
END $$;

CREATE TRIGGER inbound_change AFTER UPDATE ON inbound_messages FOR EACH ROW EXECUTE FUNCTION record_inbound_change();

CREATE FUNCTION fence_purged_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_purged_at IS NOT NULL AND OLD.content_purged_at IS NULL THEN
    UPDATE attachment_safety SET status='purged',reason='FILE_CONTENT_PURGED',lease_token=NULL,lease_expires_at=NULL,
      queued_until=NULL,updated_at=now() WHERE resource_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER outbound_attachment_purge AFTER UPDATE ON outbound_files FOR EACH ROW EXECUTE FUNCTION fence_purged_attachment();

CREATE TRIGGER inbound_attachment_purge AFTER UPDATE ON inbound_attachments FOR EACH ROW EXECUTE FUNCTION fence_purged_attachment();

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

CREATE TRIGGER outbound_delivery_change AFTER INSERT ON delivery_events FOR EACH ROW EXECUTE FUNCTION record_outbound_change();
CREATE TRIGGER outbound_submission_change AFTER INSERT ON submission_events FOR EACH ROW EXECUTE FUNCTION record_outbound_change();
`;
