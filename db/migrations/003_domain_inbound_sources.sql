CREATE TABLE "domain_inbound_sources" (
  "sending_domain_id" text NOT NULL,
  "provider_account_id" text NOT NULL,
  CONSTRAINT "domain_inbound_sources_pkey" PRIMARY KEY("sending_domain_id", "provider_account_id")
);

ALTER TABLE "domain_inbound_sources" ADD CONSTRAINT "domain_inbound_sources_sending_domain_id_fkey"
  FOREIGN KEY ("sending_domain_id") REFERENCES "public"."sending_domains"("id") ON DELETE cascade;
ALTER TABLE "domain_inbound_sources" ADD CONSTRAINT "domain_inbound_sources_provider_account_id_fkey"
  FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE cascade;
CREATE INDEX "domain_inbound_sources_provider_account_id_idx" ON "domain_inbound_sources" USING btree ("provider_account_id");

-- Existing domains retain their current inbound routes until an operator narrows the sources.
INSERT INTO "domain_inbound_sources" ("sending_domain_id", "provider_account_id")
SELECT d.id, a.id FROM "sending_domains" d CROSS JOIN "provider_accounts" a;

COMMENT ON TABLE "domain_inbound_sources" IS 'Provider accounts authorized to deliver inbound mail for each domain';
COMMENT ON COLUMN "domain_inbound_sources"."sending_domain_id" IS 'Domain receiving mail through this provider account';
COMMENT ON COLUMN "domain_inbound_sources"."provider_account_id" IS 'Authenticated provider account allowed to deliver mail for the domain';
