ALTER TABLE services
    ADD COLUMN configuration_revision integer NOT NULL DEFAULT 1 CHECK (configuration_revision > 0);

ALTER TABLE callback_endpoints ALTER COLUMN url DROP NOT NULL;
ALTER TABLE callback_endpoints
    ADD CONSTRAINT callback_url_nonempty CHECK (url IS NULL OR url <> ''),
    ADD CONSTRAINT active_callback_requires_url CHECK (status <> 'active' OR url IS NOT NULL);
