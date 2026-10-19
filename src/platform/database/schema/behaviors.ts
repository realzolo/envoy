/** Native PostgreSQL invariants included in the complete generated V1. */
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
`;
