ALTER TABLE sending_domains DROP COLUMN inbound_provider_account_id;

COMMENT ON TABLE sending_domains IS 'Managed email domains shared by service bindings; inbound mail routes by recipient domain';
