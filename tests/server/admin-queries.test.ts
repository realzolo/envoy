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
      await query(`INSERT INTO messages(id,product_id,service_id,sending_domain_id,sender_snapshot,idempotency_key,payload_hash,reference_id,recipient_count,subject,text_body,message_category)
        SELECT $1||'_'||n,'prd_atlas','svc_atlas_auth','sd_atlas',$2,$1||'_'||n,'hash',$1,1,'Historical search','body','security' FROM generate_series(1,225) n`, [prefix,{fromName:"Original sender",fromEmail:"original@mail.atlas.test",domainId:"sd_atlas"}]);
      await query(`INSERT INTO deliveries(id,message_id,recipient_email,recipient_role,lifecycle_status) SELECT id||'_d',id,'history@example.test','to',CASE WHEN id=$1||'_1' THEN 'failed' ELSE 'delivered' END FROM messages WHERE reference_id=$1`,[prefix]);
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

import { createSenderGrant, sendTestMessage, toggleSenderGrant } from "@/modules/admin/actions";
import { createMessageSchema } from "@/lib/contracts";
import { getDeliveryDetail, messageComposerData } from "@/modules/admin/queries";

describe("native admin mail", () => {
  it("accepts direct mail parameters without a preset and retains recipient roles in queries", async () => {
    const grant = await createSenderGrant({ productId: "prd_atlas", serviceId: "svc_atlas_auth", domainId: "sd_atlas", fromLocalPart: `admin-${crypto.randomUUID()}` }, "test-admin");
    const permission = (await query<{ from_local_part: string }>("SELECT from_local_part FROM sender_grants WHERE id=$1", [grant])).rows[0];
    let messageId: string | undefined;
    try {
      const result = await sendTestMessage({ serviceId: "svc_atlas_auth", idempotencyKey: crypto.randomUUID(), message: createMessageSchema.parse({
        from: { email: `${permission.from_local_part}@mail.atlas.test`, name: "Direct sender" },
        to: [{ email: "admin-to@example.test" }], cc: [{ email: "admin-cc@example.test" }], bcc: [{ email: "admin-bcc@example.test" }],
        replyTo: [{ email: "help@example.test" }], category: "security", subject: "Native console message", text: "Body",
      }) }, "test-admin");
      messageId = result.id;
      const deliveries = (await query<{id:string;recipient_role:string}>("SELECT id,recipient_role FROM deliveries WHERE message_id=$1 ORDER BY recipient_role", [result.id])).rows;
      expect(deliveries.map(item => item.recipient_role)).toEqual(["bcc", "cc", "to"]);
      const detail = await getDeliveryDetail(deliveries[0].id);
      expect(detail?.from).toBe(`Direct sender <${permission.from_local_part}@mail.atlas.test>`);
      expect(detail?.recipientRole).toBe("bcc");
      expect(detail?.content?.reply_to).toEqual([{email:"help@example.test"}]);
      expect(detail?.content?.cc_recipients).toEqual([{email:"admin-cc@example.test"}]);
      await toggleSenderGrant(grant, false, "test-admin");
      expect((await query<{ status: string }>("SELECT status FROM sender_grants WHERE id=$1", [grant])).rows[0].status).toBe("disabled");
    } finally {
      if (messageId) {
        await query("DELETE FROM outbox_events WHERE payload->>'messageId'=$1 OR payload->>'deliveryId' IN (SELECT id FROM deliveries WHERE message_id=$1) OR payload->>'submissionId' IN (SELECT id FROM submissions WHERE message_id=$1)", [messageId]);
        await query("DELETE FROM messages WHERE id=$1", [messageId]);
      }
      await query("DELETE FROM sender_grants WHERE id=$1", [grant]);
    }
  });

  it("rejects a grant scoped to another product's service", async () => {
    const productId = `prd_${crypto.randomUUID()}`;
    await query("INSERT INTO products(id,name) VALUES ($1,$2)", [productId, productId]);
    try {
      await expect(createSenderGrant({ productId, serviceId: "svc_atlas_auth", domainId: "sd_atlas" }, "test-admin")).rejects.toThrow("does not belong");
      expect((await query("SELECT id FROM sender_grants WHERE product_id=$1", [productId])).rows).toHaveLength(0);
    } finally { await query("DELETE FROM products WHERE id=$1", [productId]); }
  });

  it("returns expanded preset fields for optional console shortcuts", async () => {
    const data = await messageComposerData();
    expect(data.senders).toEqual(expect.arrayContaining([expect.objectContaining({
      name: "Atlas Security", from_name: "Atlas", from_email: "security@mail.atlas.test",
    })]));
  });
});
