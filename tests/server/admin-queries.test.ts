import { describe, expect, it } from "vitest";
import { adminData } from "@/modules/admin/queries";

describe("admin data queries", () => {
  it("returns callback ownership fields used by inbound routing", async () => {
    const data = await adminData("webhooks");

    expect(data.callbacks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "cb_atlas_local",
        service_id: "svc_atlas_auth",
        product_id: "prd_atlas"
      })
    ]));
  });
});

import { listEmailPage } from "@/modules/admin/queries";
import { query } from "@/server/database";

describe("historical delivery search", () => {
  it("searches beyond the old 200-row limit and pages tied timestamps without duplicates", async () => {
    const prefix=`history_${crypto.randomUUID()}`;
    try {
      await query(`INSERT INTO messages(id,product_id,service_id,sender_profile_id,sender_snapshot,idempotency_key,payload_hash,reference_id,recipient_count,subject,text_body,message_category)
        SELECT $1||'_'||n,'prd_atlas','svc_atlas_auth','sp_atlas_security',$2,$1||'_'||n,'hash',$1,1,'Historical search','body','security' FROM generate_series(1,225) n`, [prefix,{fromName:"Original sender",fromEmail:"original@mail.atlas.test",domainId:"sd_atlas",senderProfile:"Atlas Security"}]);
      await query(`INSERT INTO deliveries(id,message_id,recipient_email,lifecycle_status) SELECT id||'_d',id,'history@example.test',CASE WHEN id=$1||'_1' THEN 'failed' ELSE 'delivered' END FROM messages WHERE reference_id=$1`,[prefix]);
      const ids=new Set<string>();
      let cursor: string | undefined;
      do {
        const page=await listEmailPage({q:prefix,status:"all",cursor},20);
        for (const record of page.records) {
          expect(ids.has(record.id)).toBe(false);
          expect(record.from).toBe("Original sender <original@mail.atlas.test>");
          ids.add(record.id);
        }
        cursor=page.nextCursor ?? undefined;
      } while(cursor);
      expect(ids.size).toBe(225);
      expect((await listEmailPage({q:prefix,status:"failed"})).records).toHaveLength(1);
      expect((await listEmailPage({q:prefix,status:"all",cursor:"invalid"})).records).toHaveLength(20);
    } finally { await query("DELETE FROM messages WHERE reference_id=$1",[prefix]); }
  });
});
