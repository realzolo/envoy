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
CREATE FUNCTION revise_delivery_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.lifecycle_status,NEW.engagement_status,NEW.compliance_status,NEW.current_submission_id,NEW.current_attempt_id,NEW.diagnostic,NEW.retry_disposition,NEW.accepted_at,NEW.delivered_at)
 IS DISTINCT FROM ROW(OLD.lifecycle_status,OLD.engagement_status,OLD.compliance_status,OLD.current_submission_id,OLD.current_attempt_id,OLD.diagnostic,OLD.retry_disposition,OLD.accepted_at,OLD.delivered_at) THEN
  NEW.revision:=OLD.revision+1; NEW.updated_at:=clock_timestamp();
 ELSE NEW.revision:=OLD.revision; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER delivery_snapshot_revision BEFORE UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION revise_delivery_snapshot();

`;

export const mailDiagnosticValidation = String.raw`CREATE FUNCTION valid_mail_diagnostic(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; e jsonb;
BEGIN
 IF p IS NULL THEN RETURN true; END IF;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['source','code','reasonCode','stage','detailAvailability','evidence','occurredAt'] THEN RETURN false; END IF;
 FOR k IN SELECT unnest(ARRAY['source','code','stage','detailAvailability']) LOOP IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' THEN RETURN false; END IF; END LOOP;
 FOR k IN SELECT jsonb_object_keys(p) LOOP IF k<>ALL(ARRAY['source','code','reasonCode','stage','detailAvailability','evidence','occurredAt']) THEN RETURN false; END IF; END LOOP;
 IF p->>'source'<>ALL(ARRAY['MORPH','ENVOY','PROVIDER']) OR p->>'code'<>ALL(ARRAY['MAILBOX_PERMANENTLY_REJECTED','MAILBOX_TEMPORARILY_REJECTED','DELIVERY_FAILED','DELIVERY_DEFERRED','RECIPIENT_SUPPRESSED','PROVIDER_AUTHENTICATION_FAILED','PROVIDER_RATE_LIMITED','INVALID_RECIPIENT','PROVIDER_POLICY_REJECTED','PROVIDER_REJECTED','PROVIDER_UNAVAILABLE','PROVIDER_CONNECTION_UNAVAILABLE','SUBMISSION_OUTCOME_UNKNOWN','SUBMISSION_GUARD_REJECTED','INTERRUPTED_SUBMISSION','SEND_DEADLINE_EXCEEDED','CONTENT_EXPIRED','SENDER_NOT_AUTHORIZED','NO_ELIGIBLE_ROUTE','UNSUPPORTED_MESSAGE_CAPABILITY','UNSUPPORTED_MAIL_FEATURE','ROUTE_TEMPORARILY_UNAVAILABLE','LOCAL_PREPARATION_FAILED','RECONCILIATION_EXHAUSTED','PROVIDER_NOT_ACCEPTED','WORKFLOW_EXHAUSTED','FILE_NOT_READY','FILE_UNAVAILABLE','UNCLASSIFIED_FAILURE','VALIDATION_FAILED']) OR p->>'stage'<>ALL(ARRAY['PREPARATION','AUTHORIZATION','ROUTING','SUBMISSION','RECIPIENT_DELIVERY','RECONCILIATION','QUEUE','POLICY','OBSERVATION'])
 OR p->>'detailAvailability'<>ALL(ARRAY['SPECIFIC','CATEGORY_ONLY','NOT_RECORDED','PROVIDER_NOT_SUPPLIED']) THEN RETURN false; END IF;
 IF p->'reasonCode'<>'null'::jsonb AND (jsonb_typeof(p->'reasonCode')<>'string' OR p->>'reasonCode'<>ALL(ARRAY['MAILBOX_NOT_FOUND','DOMAIN_INVALID','MAILBOX_DISABLED','MAILBOX_FULL','MESSAGE_TOO_LARGE','CONTENT_REJECTED','ATTACHMENT_REJECTED','RECIPIENT_SUPPRESSED','PROVIDER_QUOTA_EXCEEDED','PROVIDER_RATE_LIMITED','PROVIDER_AUTH_FAILED','PROVIDER_PERMISSION_DENIED','SENDER_NOT_VERIFIED','INVALID_RECIPIENT','PROVIDER_REQUEST_INVALID'])) THEN RETURN false; END IF;
 IF (p->>'detailAvailability'='SPECIFIC') IS DISTINCT FROM (p->'reasonCode'<>'null'::jsonb) THEN RETURN false; END IF;
 IF p->'occurredAt'<>'null'::jsonb THEN
  IF jsonb_typeof(p->'occurredAt') IS DISTINCT FROM 'string' OR p->>'occurredAt'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RETURN false; END IF;
  PERFORM (p->>'occurredAt')::timestamptz;
 END IF;
 e:=p->'evidence'; IF jsonb_typeof(e) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOR k IN SELECT jsonb_object_keys(e) LOOP IF k<>ALL(ARRAY['smtpReplyCode','smtpStatus','bounceClass','suppressionReason']) THEN RETURN false; END IF; END LOOP;
 IF e ? 'smtpStatus' AND (jsonb_typeof(e->'smtpStatus')<>'string' OR e->>'smtpStatus'!~'^[245]\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$') THEN RETURN false; END IF;
 IF e ? 'smtpReplyCode' AND (jsonb_typeof(e->'smtpReplyCode')<>'number' OR e->>'smtpReplyCode'!~'^[45][0-9]{2}$') THEN RETURN false; END IF;
 IF e ? 'bounceClass' AND (jsonb_typeof(e->'bounceClass') IS DISTINCT FROM 'string' OR e->>'bounceClass'<>ALL(ARRAY['HARD','SOFT','UNKNOWN'])) THEN RETURN false; END IF;
 IF e ? 'suppressionReason' AND (jsonb_typeof(e->'suppressionReason') IS DISTINCT FROM 'string' OR e->>'suppressionReason'<>ALL(ARRAY['HARD_BOUNCE','COMPLAINED','PROVIDER_SUPPRESSED','SOFT_BOUNCE_THRESHOLD','UNSUBSCRIBE','MANUAL'])) THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION valid_mail_retry(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['owner','action','nextAttemptAt'] THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p))<>3 OR jsonb_typeof(p->'owner') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'action') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 IF NOT ((p->>'owner'='ENVOY' AND p->>'action' IN ('SCHEDULED','MANUAL_REVIEW')) OR (p->>'owner'='PROVIDER' AND p->>'action'='WAITING_PROVIDER') OR (p->>'owner'='NONE' AND p->>'action'='STOPPED') OR (p->>'owner'='UNKNOWN' AND p->>'action'='MANUAL_REVIEW')) THEN RETURN false; END IF;
 IF p->'nextAttemptAt'<>'null'::jsonb THEN
  IF p->>'action'<>'SCHEDULED' OR jsonb_typeof(p->'nextAttemptAt') IS DISTINCT FROM 'string' OR p->>'nextAttemptAt'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RETURN false; END IF;
  PERFORM (p->>'nextAttemptAt')::timestamptz;
 END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

`;
