vi.mock("@/server/admin-auth", () => ({ getAdminSession: vi.fn().mockResolvedValue({ email: "admin@example.test" }) }));
import { describe, expect, it, vi } from "vitest";
import { getAdminSession } from "@/server/admin-auth";
import { adminData,dashboardData } from "@/server/admin-queries";

describe("admin data queries", () => {
  it("returns callback ownership fields used by inbound routing", async () => {
    const data = await adminData("webhooks");

    expect(data.callbacks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "cb_atlas_local",
        service_id: "svc_atlas_auth",
      })
    ]));
  });
});

import { listEmailPage } from "@/server/admin-queries";
import { query } from "@/platform/database";

describe("historical delivery search", () => {
  it("searches beyond the old 200-row limit and pages tied timestamps without duplicates", async () => {
    const prefix=`history_${crypto.randomUUID()}`;
    try {
      await query(`INSERT INTO messages(id,service_id,sending_domain_id,sender_snapshot,idempotency_key,payload_hash,reference_id,recipient_count,subject,text_body,message_category)
        SELECT $1||'_'||n,'svc_atlas_auth','sd_atlas',$2,$1||'_'||n,'hash',$1,1,'Historical search','body','security' FROM generate_series(1,225) n`, [prefix,{fromName:"Original sender",fromEmail:"original@mail.atlas.test",domainId:"sd_atlas"}]);
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

import { sendTestMessage } from "@/modules/outbound/public";
import { createMessageSchema } from "@/lib/contracts";
import { getDeliveryDetail, messageComposerData } from "@/server/admin-queries";

describe("native admin mail", () => {
  it("shows receiving Service count without domain-level provider configuration", async () => {
    const data=await adminData("domains");
    const domain=data.domains?.find(item=>item.id==="sd_atlas");
    expect(domain?.receiving_service_count).toBeGreaterThan(0);
    expect(domain?.inbound_source_account_ids).toEqual(["pa_mock"]);
    expect(domain).not.toHaveProperty("inbound_provider_account_id");
    expect(domain).not.toHaveProperty("inbound_ready");
  });

  it("accepts manually entered mail parameters and retains recipient roles in queries", async () => {
    const permission={from_local_part:`admin-${crypto.randomUUID()}`};
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
    } finally {
      if (messageId) {
        await query("DELETE FROM outbox_events WHERE payload->>'messageId'=$1 OR payload->>'deliveryId' IN (SELECT id FROM deliveries WHERE message_id=$1) OR payload->>'submissionId' IN (SELECT id FROM submissions WHERE message_id=$1)", [messageId]);
        await query("DELETE FROM messages WHERE id=$1", [messageId]);
      }
    }
  });

  it("loads active services for composition and sending permissions for credential management", async () => {
    const composer = await messageComposerData();
    expect(composer.services).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "svc_atlas_auth",
    })]));
    const access = await adminData("api-keys");
    expect(access.services).toEqual(expect.arrayContaining([expect.objectContaining({ id: "svc_atlas_auth" })]));
    expect(access.domains).toEqual(expect.arrayContaining([expect.objectContaining({ id: "sd_atlas" })]));
    expect(access.services).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "svc_atlas_auth", domain_bindings: expect.arrayContaining([expect.objectContaining({sending_domain_id:"sd_atlas"})]),
    })]));
    const dashboard=await dashboardData();
    expect(dashboard.setup.chains).toEqual(expect.arrayContaining([expect.objectContaining({id:"svc_atlas_auth:sd_atlas",grant:true,route:true})]));
  });
});

describe("admin data authorization", () => {
  it("rejects reads when there is no administrator session", async () => {
    vi.mocked(getAdminSession).mockResolvedValueOnce(null);
    await expect(adminData("webhooks")).rejects.toThrow("Unauthorized");
  });
});
