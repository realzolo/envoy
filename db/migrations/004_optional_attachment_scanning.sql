ALTER TABLE "attachment_safety" DROP CONSTRAINT "attachment_safety_status_check";
ALTER TABLE "attachment_safety" ADD CONSTRAINT "attachment_safety_status_check"
  CHECK (status = ANY (ARRAY['pending'::text, 'scanning'::text, 'clean'::text, 'verified'::text, 'malicious'::text, 'unavailable'::text, 'blocked'::text, 'purged'::text]));
