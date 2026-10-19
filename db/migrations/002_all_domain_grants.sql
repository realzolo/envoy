-- A NULL domain grants access to all registered domains, including future ones.
ALTER TABLE service_domain_grants ALTER COLUMN sending_domain_id DROP NOT NULL;

CREATE UNIQUE INDEX service_domain_grants_one_all_per_service
    ON service_domain_grants(service_id) WHERE sending_domain_id IS NULL;
