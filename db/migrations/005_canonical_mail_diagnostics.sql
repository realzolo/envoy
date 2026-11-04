CREATE FUNCTION migrate_mail_diagnostic(p jsonb, fallback_code text, at_time timestamptz) RETURNS jsonb LANGUAGE sql AS $$
 SELECT CASE WHEN p IS NULL AND fallback_code IS NULL THEN NULL ELSE jsonb_build_object(
  'source',CASE WHEN p->>'stage'='recipient_delivery' OR COALESCE(p->>'code',fallback_code)=ANY(ARRAY['PROVIDER_AUTHENTICATION_FAILED','PROVIDER_RATE_LIMITED','INVALID_RECIPIENT','PROVIDER_POLICY_REJECTED','PROVIDER_REJECTED','PROVIDER_UNAVAILABLE','PROVIDER_CONNECTION_UNAVAILABLE']) THEN 'PROVIDER' ELSE 'ENVOY' END,
  'code',CASE WHEN COALESCE(p->>'code',fallback_code)=ANY(ARRAY['MAILBOX_PERMANENTLY_REJECTED','MAILBOX_TEMPORARILY_REJECTED','DELIVERY_FAILED','DELIVERY_DEFERRED','RECIPIENT_SUPPRESSED','PROVIDER_AUTHENTICATION_FAILED','PROVIDER_RATE_LIMITED','INVALID_RECIPIENT','PROVIDER_POLICY_REJECTED','PROVIDER_REJECTED','PROVIDER_UNAVAILABLE','PROVIDER_CONNECTION_UNAVAILABLE','SUBMISSION_OUTCOME_UNKNOWN','SUBMISSION_GUARD_REJECTED','INTERRUPTED_SUBMISSION','SEND_DEADLINE_EXCEEDED','CONTENT_EXPIRED','SENDER_NOT_AUTHORIZED','NO_ELIGIBLE_ROUTE','UNSUPPORTED_MESSAGE_CAPABILITY','UNSUPPORTED_MAIL_FEATURE','ROUTE_TEMPORARILY_UNAVAILABLE','LOCAL_PREPARATION_FAILED','RECONCILIATION_EXHAUSTED','PROVIDER_NOT_ACCEPTED','WORKFLOW_EXHAUSTED','FILE_NOT_READY','FILE_UNAVAILABLE','UNCLASSIFIED_FAILURE','VALIDATION_FAILED']) THEN COALESCE(p->>'code',fallback_code) ELSE 'UNCLASSIFIED_FAILURE' END,
  'reasonCode',NULL,'stage',CASE WHEN upper(p->>'stage')=ANY(ARRAY['PREPARATION','AUTHORIZATION','ROUTING','SUBMISSION','RECIPIENT_DELIVERY','RECONCILIATION','QUEUE','POLICY','OBSERVATION']) THEN upper(p->>'stage') ELSE 'OBSERVATION' END,
  'detailAvailability','NOT_RECORDED','evidence',CASE WHEN p->>'code'='MAILBOX_PERMANENTLY_REJECTED' THEN '{"bounceClass":"HARD"}'::jsonb WHEN p->>'code'='MAILBOX_TEMPORARILY_REJECTED' THEN '{"bounceClass":"SOFT"}'::jsonb ELSE '{}'::jsonb END,
  'occurredAt',CASE WHEN p->>'occurredAt' IS NOT NULL THEN p->>'occurredAt' ELSE NULL END) END;
$$;
ALTER TABLE deliveries RENAME COLUMN last_error TO diagnostic;
ALTER TABLE deliveries ADD COLUMN revision bigint NOT NULL DEFAULT 1;
ALTER TABLE deliveries ADD COLUMN retry_disposition jsonb NOT NULL DEFAULT '{"owner":"ENVOY","action":"SCHEDULED","nextAttemptAt":null}';
UPDATE deliveries d SET diagnostic=migrate_mail_diagnostic(diagnostic,NULL,updated_at),retry_disposition=jsonb_build_object(
 'owner',CASE WHEN (d.lifecycle_status='accepted' OR (d.lifecycle_status='deferred' AND (d.accepted_at IS NOT NULL OR EXISTS(SELECT 1 FROM submission_attempts a WHERE a.id=d.current_attempt_id AND a.status IN ('accepted','reconciled'))))) THEN 'PROVIDER' WHEN lifecycle_status IN ('queued','submitting','deferred') OR (d.lifecycle_status='unknown' AND EXISTS(SELECT 1 FROM submission_attempts a WHERE a.id=d.current_attempt_id AND a.status IN ('unknown','reconciling') AND a.reconcile_after IS NOT NULL AND a.reconciliation_count<12)) THEN 'ENVOY' WHEN lifecycle_status='unknown' THEN 'UNKNOWN' ELSE 'NONE' END,
 'action',CASE WHEN (d.lifecycle_status='accepted' OR (d.lifecycle_status='deferred' AND (d.accepted_at IS NOT NULL OR EXISTS(SELECT 1 FROM submission_attempts a WHERE a.id=d.current_attempt_id AND a.status IN ('accepted','reconciled'))))) THEN 'WAITING_PROVIDER' WHEN lifecycle_status='deferred' AND diagnostic->>'code'='WORKFLOW_EXHAUSTED' THEN 'MANUAL_REVIEW' WHEN lifecycle_status IN ('queued','submitting','deferred') OR (d.lifecycle_status='unknown' AND EXISTS(SELECT 1 FROM submission_attempts a WHERE a.id=d.current_attempt_id AND a.status IN ('unknown','reconciling') AND a.reconcile_after IS NOT NULL AND a.reconciliation_count<12)) THEN 'SCHEDULED' WHEN lifecycle_status='unknown' THEN 'MANUAL_REVIEW' ELSE 'STOPPED' END,
 'nextAttemptAt',CASE WHEN (d.lifecycle_status='unknown' AND EXISTS(SELECT 1 FROM submission_attempts a WHERE a.id=d.current_attempt_id AND a.status IN ('unknown','reconciling') AND a.reconcile_after IS NOT NULL AND a.reconciliation_count<12)) THEN (SELECT to_char(a.reconcile_after AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM submission_attempts a WHERE a.id=d.current_attempt_id) ELSE NULL END);
UPDATE deliveries SET diagnostic=migrate_mail_diagnostic(NULL,CASE lifecycle_status WHEN 'bounced' THEN 'DELIVERY_FAILED' WHEN 'failed' THEN 'DELIVERY_FAILED' ELSE 'UNCLASSIFIED_FAILURE' END,updated_at) WHERE diagnostic IS NULL AND lifecycle_status IN ('bounced','failed','unknown');
UPDATE submission_attempts SET diagnostic=migrate_mail_diagnostic(diagnostic,error_code,finished_at);
ALTER TABLE submission_attempts DROP COLUMN error_message,DROP COLUMN error_code,DROP COLUMN error_category;
UPDATE delivery_events SET canonical_payload=(canonical_payload-'bounce'-'metadata'-'reason'-'diagnostic') || jsonb_build_object('metadata',CASE WHEN canonical_payload#>'{metadata,diagnostic}' IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('diagnostic',migrate_mail_diagnostic(canonical_payload#>'{metadata,diagnostic}',NULL,occurred_at)) END)
 || CASE WHEN canonical_payload ? 'bounce' THEN jsonb_build_object('bounce',jsonb_build_object('classification',CASE lower(canonical_payload#>>'{bounce,classification}') WHEN 'hard' THEN 'HARD' WHEN 'soft' THEN 'SOFT' ELSE 'UNKNOWN' END)) ELSE '{}'::jsonb END;
UPDATE submission_events SET canonical_payload=(canonical_payload-'bounce'-'metadata'-'reason'-'diagnostic') || jsonb_build_object('metadata',CASE WHEN canonical_payload#>'{metadata,diagnostic}' IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('diagnostic',migrate_mail_diagnostic(canonical_payload#>'{metadata,diagnostic}',NULL,occurred_at)) END);
UPDATE raw_provider_events SET normalized_events=(SELECT jsonb_agg((e-'metadata'-'bounce') || jsonb_build_object('metadata','{}'::jsonb) || CASE WHEN e ? 'bounce' THEN jsonb_build_object('bounce',jsonb_build_object('classification',CASE lower(e#>>'{bounce,classification}') WHEN 'hard' THEN 'HARD' WHEN 'soft' THEN 'SOFT' ELSE 'UNKNOWN' END)) ELSE '{}'::jsonb END) FROM jsonb_array_elements(normalized_events) e) WHERE normalized_events IS NOT NULL;
UPDATE request_logs SET details=jsonb_set(details,'{problem,diagnostic}',CASE WHEN details#>>'{problem,code}'='VALIDATION_FAILED' THEN migrate_mail_diagnostic('{"code":"VALIDATION_FAILED","stage":"observation"}'::jsonb,NULL,NULL) ELSE 'null'::jsonb END) WHERE jsonb_typeof(details->'problem')='object';
DROP FUNCTION migrate_mail_diagnostic(jsonb,text,timestamptz);
CREATE FUNCTION valid_mail_diagnostic(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
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

CREATE FUNCTION revise_delivery_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.lifecycle_status,NEW.engagement_status,NEW.compliance_status,NEW.current_submission_id,NEW.current_attempt_id,NEW.diagnostic,NEW.retry_disposition,NEW.accepted_at,NEW.delivered_at)
 IS DISTINCT FROM ROW(OLD.lifecycle_status,OLD.engagement_status,OLD.compliance_status,OLD.current_submission_id,OLD.current_attempt_id,OLD.diagnostic,OLD.retry_disposition,OLD.accepted_at,OLD.delivered_at) THEN
  NEW.revision:=OLD.revision+1; NEW.updated_at:=clock_timestamp();
 ELSE NEW.revision:=OLD.revision; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER delivery_snapshot_revision BEFORE UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION revise_delivery_snapshot();
ALTER TABLE deliveries ADD CONSTRAINT deliveries_revision_check CHECK(revision>0);
ALTER TABLE deliveries ADD CONSTRAINT deliveries_diagnostic_check CHECK(valid_mail_diagnostic(diagnostic));
ALTER TABLE deliveries ADD CONSTRAINT deliveries_retry_check CHECK(valid_mail_retry(retry_disposition));
ALTER TABLE submission_attempts ADD CONSTRAINT submission_attempts_diagnostic_check CHECK(valid_mail_diagnostic(diagnostic));
COMMENT ON COLUMN deliveries.diagnostic IS 'Canonical content-free MailDiagnostic; no provider free text';
COMMENT ON COLUMN deliveries.revision IS 'Monotonic version of the complete current delivery snapshot';
COMMENT ON COLUMN deliveries.retry_disposition IS 'Current retry responsibility and disposition, independent of manual action authorization';
