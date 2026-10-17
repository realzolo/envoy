import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { afterAll,describe,expect,it } from "vitest";
import { db } from "@/server/database";
import { adoptSchema,baselineChecksum } from "../../scripts/adopt-schema";

const source=await readFile(new URL("../../db/migrations/001_initial.sql",import.meta.url),"utf8");
afterAll(async()=>{await db().end();});
describe("reviewed schema adoption on isolated test schemas",()=>{
 it("preflights without mutation, adopts existing data without fabricated times, and preserves the ledger",async()=>{
  const client=await db().connect();
  const schema=`adopt_${crypto.randomUUID().replaceAll("-","")}`;
  try {
   await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path TO ${schema},public`);
   await client.query(source);
   // Model the reviewed baseline catalog. This test never touches a developer database.
   await client.query(`DROP TRIGGER inbound_change ON inbound_messages; DROP FUNCTION record_inbound_change();
     DROP TABLE inbound_changes,inbound_streams,inbound_receipts;
     DROP INDEX inbound_evidence; DROP INDEX submission_events_evidence; DROP INDEX inbound_messages_service_stored_cursor;
     ALTER TABLE inbound_messages DROP COLUMN author_date,DROP COLUMN ingress_received_at,DROP COLUMN ready_at;
     ALTER TABLE inbound_messages ALTER COLUMN received_at DROP DEFAULT;
     ALTER TABLE submission_attempts DROP COLUMN rfc_message_id; ALTER TABLE raw_provider_events DROP COLUMN terminated_at;
     ALTER TABLE callback_deliveries DROP COLUMN terminated_at;
     ALTER TABLE callback_deliveries DROP CONSTRAINT callback_deliveries_status_check;
     ALTER TABLE callback_deliveries ADD CHECK(status IN ('pending','delivering','delivered','retrying','dead_letter'));
     CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text,applied_at timestamptz DEFAULT now());`);
   await client.query("INSERT INTO schema_migrations(name,checksum,applied_at) VALUES('001_initial.sql',$1,'2020-01-01Z')",[baselineChecksum]);
   await client.query("INSERT INTO products(id,name) VALUES('p','p'); INSERT INTO services(id,product_id,name) VALUES('s','p','s'); INSERT INTO provider_accounts(id,type,name,public_config) VALUES('pa','mock','pa','{}')");
   await client.query(`INSERT INTO inbound_messages(id,provider_account_id,service_id,product_id,delivery_scope,external_message_id,from_email,to_emails,subject,status,received_at,created_at)
     VALUES('old','pa','s','p','s','external','a@test.example','{}','body','ready','2099-01-01Z','2020-01-01Z')`);
   expect(await adoptSchema(client,source,false)).toMatchObject({state:"preflight_ok",ready:"1"});
   expect((await client.query("SELECT checksum FROM schema_migrations")).rows[0].checksum).toBe(baselineChecksum);
   expect((await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='inbound_messages' AND column_name='author_date'",[schema])).rowCount).toBe(0);
   await expect(adoptSchema(client,source,true)).resolves.toMatchObject({state:"adopted",legacyReadyCopies:1});
   expect((await client.query("SELECT author_date,ingress_received_at,ready_at,received_at FROM inbound_messages")).rows[0]).toMatchObject({author_date:null,ingress_received_at:null,ready_at:null,received_at:new Date("2099-01-01Z")});
   expect((await client.query("SELECT type,recorded_at FROM inbound_changes")).rows[0]).toMatchObject({type:"inbound.available",recorded_at:expect.any(Date)});
   expect((await client.query("SELECT routes FROM inbound_receipts")).rows[0].routes).toEqual([]);
   const ledger=(await client.query("SELECT * FROM schema_migrations")).rows[0];
   expect(ledger).toMatchObject({checksum:createHash("sha256").update(source).digest("hex"),applied_at:new Date("2020-01-01Z")});
   expect((await client.query("SELECT details FROM audit_logs WHERE action='schema.adopt'")).rows[0].details).toMatchObject({baseline:baselineChecksum,unverifiedHistoricalTimes:true});
   expect(await adoptSchema(client,source,true)).toMatchObject({state:"already_current"});
   await client.query("UPDATE schema_migrations SET checksum='unknown'");
   await expect(adoptSchema(client,source,true)).rejects.toThrow("Only the reviewed");
   expect((await client.query("SELECT subject FROM inbound_messages")).rows[0].subject).toBe("body");
  } finally {await client.query("SET search_path TO public");await client.query(`DROP SCHEMA ${schema} CASCADE`);client.release();}
 });
});
