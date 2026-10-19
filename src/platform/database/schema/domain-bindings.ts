import { boolean, foreignKey, index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { services } from "./identity";
import { providerIdentities, sendingDomains } from "./channels";

export const serviceDomainBindings = pgTable("service_domain_bindings", {
  id: text().primaryKey().notNull(),
  serviceId: text("service_id").notNull(),
  sendingDomainId: text("sending_domain_id").notNull(),
  receiveEnabled: boolean("receive_enabled").default(false).notNull(),
  outboundProviderIdentityId: text("outbound_provider_identity_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
}, table => [
  foreignKey({ columns: [table.serviceId], foreignColumns: [services.id], name: "service_domain_bindings_service_id_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [table.sendingDomainId], foreignColumns: [sendingDomains.id], name: "service_domain_bindings_sending_domain_id_fkey" }).onDelete("cascade"),
  foreignKey({
    columns: [table.outboundProviderIdentityId, table.sendingDomainId],
    foreignColumns: [providerIdentities.id, providerIdentities.sendingDomainId],
    name: "service_domain_bindings_outbound_identity_domain_fkey",
  }).onDelete("restrict"),
  unique("service_domain_bindings_service_domain_key").on(table.serviceId, table.sendingDomainId),
  index("service_domain_bindings_inbound_fanout").on(table.sendingDomainId).where(sql`${table.receiveEnabled}`),
]);
