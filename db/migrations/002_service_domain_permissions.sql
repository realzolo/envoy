-- Development-only final model: no old ACL conversion or compatibility paths.
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM messages)
    OR EXISTS(SELECT 1 FROM inbound_messages)
    OR EXISTS(SELECT 1 FROM outbound_files)
    OR EXISTS(SELECT 1 FROM raw_provider_events)
    OR EXISTS(SELECT 1 FROM inbound_receipts)
    OR EXISTS(SELECT 1 FROM callback_deliveries) THEN
    RAISE EXCEPTION '002_service_domain_permissions requires empty development mail business tables; no data is reset or converted';
  END IF;
  IF EXISTS(SELECT 1 FROM inbound_routes WHERE service_id IS NULL) THEN
    RAISE EXCEPTION 'Every inbound route must select a business Service before applying 002_service_domain_permissions';
  END IF;
  IF EXISTS(SELECT service_id FROM callback_endpoints GROUP BY service_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Configure one unified callback per Service before applying 002_service_domain_permissions';
  END IF;
END $$;
DROP TABLE sender_grants;
CREATE TABLE service_domain_grants (
  id text PRIMARY KEY,
  service_id text NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  sending_domain_id text NOT NULL REFERENCES sending_domains(id) ON DELETE CASCADE,
  send_allowed boolean NOT NULL DEFAULT false,
  receive_allowed boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(service_id,sending_domain_id),
  CHECK(send_allowed OR receive_allowed)
);
ALTER TABLE services ADD COLUMN suppression_management_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE outbound_files ADD COLUMN sending_domain_id text NOT NULL REFERENCES sending_domains(id) ON DELETE RESTRICT;
DROP INDEX inbound_route_scope;
ALTER TABLE inbound_routes DROP COLUMN local_part_pattern, DROP COLUMN callback_endpoint_id;
ALTER TABLE inbound_routes ALTER COLUMN service_id SET NOT NULL;
CREATE UNIQUE INDEX inbound_route_scope ON inbound_routes(provider_webhook_endpoint_id,sending_domain_id,service_id);
CREATE UNIQUE INDEX callback_one_per_service ON callback_endpoints(service_id);
