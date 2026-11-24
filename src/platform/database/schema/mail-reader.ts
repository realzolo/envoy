import { sql } from "drizzle-orm";
import { pgTable, text, jsonb, bigint, integer, timestamp, primaryKey, index, check } from "drizzle-orm/pg-core";
export const mailReaderResources = pgTable("mail_reader_resources", {
  sourceKind: text("source_kind").notNull(), sourceId: text("source_id").notNull(), sourceRevision: text("source_revision").notNull(), resourceId: text("resource_id").notNull(),
  serviceId: text("service_id"), state: text().default("PENDING").notNull(), reasonCode: text("reason_code"),
  cachedContent: jsonb("cached_content"), contentType: text("content_type"), sizeBytes: bigint("size_bytes", {mode:"number"}), sha256: text(),
  attemptCount: integer("attempt_count").default(0).notNull(), availableAt: timestamp("available_at", {withTimezone:true,mode:"string"}).defaultNow().notNull(),
  leaseToken: text("lease_token"), leaseExpiresAt: timestamp("lease_expires_at", {withTimezone:true,mode:"string"}),
  createdAt: timestamp("created_at", {withTimezone:true,mode:"string"}).defaultNow().notNull(), updatedAt: timestamp("updated_at", {withTimezone:true,mode:"string"}).defaultNow().notNull(),
}, table => [primaryKey({name:"mail_reader_resources_pkey",columns:[table.sourceKind,table.sourceId,table.sourceRevision,table.resourceId]}),
  index("mail_reader_resource_work").on(table.state,table.availableAt),
  check("mail_reader_source_kind", sql`source_kind IN ('INBOUND','OUTBOUND')`),
  check("mail_reader_state", sql`state IN ('PENDING','RUNNING','READY','RETRY_WAIT','UNAVAILABLE')`),
  check("mail_reader_size", sql`size_bytes IS NULL OR (size_bytes > 0 AND size_bytes <= 20000000)`),
  check("mail_reader_ready", sql`state <> 'READY' OR (cached_content IS NOT NULL AND content_type IS NOT NULL AND size_bytes IS NOT NULL AND sha256 ~ '^[a-f0-9]{64}$')`),
]);
