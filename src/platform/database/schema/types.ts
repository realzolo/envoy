import { customType } from "drizzle-orm/pg-core";

/** PostgreSQL bytea is a Buffer at the pg driver boundary. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
