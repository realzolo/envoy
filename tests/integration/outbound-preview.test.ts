import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptMessage, getOutboundPreview, readOutboundPreviewResource } from "@/modules/outbound/public";
import { uploadOutboundFile } from "@/modules/attachments/public";
import { query, db } from "@/platform/database";
import { objectStore } from "@/platform/storage/object-store";
import { scanClean } from "../helpers/scanner";
import { createMessageSchema } from "@/lib/contracts";

const tag = crypto.randomUUID(), serviceId = `svc_preview_${tag}`, bindingId = `sdb_preview_${tag}`;
const identity = {serviceId,serviceName:"Preview fixture",rateLimitPerMinute:600};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=","base64");
let deliveryId: string, fileId: string;
const html = '<style>.brand{background:url(cid:app-logo)}</style><table><tr><td><img src="cid:app-logo" alt="App logo"></td></tr></table>';

beforeAll(async () => {
  await query("INSERT INTO services(id,name) VALUES ($1,'Preview fixture')",[serviceId]);
  await query("INSERT INTO service_domain_bindings(id,service_id,sending_domain_id,outbound_provider_identity_id) VALUES ($1,$2,'sd_atlas','pi_atlas_mock')",[bindingId,serviceId]);
  const file = await uploadOutboundFile(serviceId,"app-logo.png","image/png",png,"mail.atlas.test");
  fileId = file.id; await scanClean(fileId);
  const accepted = await acceptMessage({identity,idempotencyKey:crypto.randomUUID(),input:createMessageSchema.parse({
    from:{email:"support@mail.atlas.test"},to:[{email:"recipient@example.test"}],category:"transactional",subject:"Preview fixture",html,
    attachments:[{fileId,disposition:"inline",contentId:"app-logo"}],
  })});
  deliveryId = (await query<{id:string}>("SELECT id FROM deliveries WHERE message_id=$1",[accepted.message.id])).rows[0].id;
});
afterAll(async () => {
  for (const file of (await query<{object_key:string}>("SELECT object_key FROM outbound_files WHERE service_id=$1",[serviceId])).rows) await objectStore().delete(file.object_key);
  await query("DELETE FROM outbox_events WHERE payload->>'submissionId' IN (SELECT s.id FROM submissions s JOIN messages m ON m.id=s.message_id WHERE m.service_id=$1)",[serviceId]);
  await query("DELETE FROM messages WHERE service_id=$1",[serviceId]);
  await query("DELETE FROM outbound_files WHERE service_id=$1",[serviceId]);
  await query("DELETE FROM services WHERE id=$1",[serviceId]);
  await db().end();
});

describe("stored outbound HTML preview", () => {
  it("loads the accepted inline bitmap without changing the saved body or leaking storage keys", async () => {
    const preview = await getOutboundPreview(deliveryId);
    expect(preview.resources).toEqual([{id:"image_1",kind:"CID",available:true}]);
    expect(JSON.stringify(preview)).not.toContain(fileId); expect(JSON.stringify(preview)).not.toContain("outbound/");
    const image = await readOutboundPreviewResource(deliveryId,"image_1",preview.revision,false);
    expect(Buffer.from(image.bytes)).toEqual(png); expect(image.contentType).toBe("image/png");
    expect((await query<{html_body:string}>("SELECT html_body FROM messages WHERE service_id=$1",[serviceId])).rows[0].html_body).toBe(html);
  });
  it("honors safety rejection and current scanner policy on every image read", async () => {
    const preview = await getOutboundPreview(deliveryId);
    await query("UPDATE attachment_safety SET status='malicious' WHERE resource_id=$1",[fileId]);
    try { await expect(readOutboundPreviewResource(deliveryId,"image_1",preview.revision,false)).rejects.toMatchObject({code:"IMAGE_UNAVAILABLE"}); }
    finally { await query("UPDATE attachment_safety SET status='clean' WHERE resource_id=$1",[fileId]); }
    await query("UPDATE attachment_safety SET policy_version='obsolete' WHERE resource_id=$1",[fileId]);
    try { await expect(readOutboundPreviewResource(deliveryId,"image_1",preview.revision,false)).rejects.toMatchObject({code:"IMAGE_UNAVAILABLE"}); }
    finally { await query("UPDATE attachment_safety SET policy_version='1' WHERE resource_id=$1",[fileId]); }
  });
  it("revokes both manifest and image access when the sending grant is removed", async () => {
    const preview = await getOutboundPreview(deliveryId);
    await query("UPDATE service_domain_bindings SET outbound_provider_identity_id=NULL WHERE id=$1",[bindingId]);
    try {
      await expect(getOutboundPreview(deliveryId)).rejects.toMatchObject({status:404});
      await expect(readOutboundPreviewResource(deliveryId,"image_1",preview.revision,false)).rejects.toMatchObject({status:404});
    } finally { await query("UPDATE service_domain_bindings SET outbound_provider_identity_id='pi_atlas_mock' WHERE id=$1",[bindingId]); }
  });
  it("does not expose image bytes for purged or sensitive messages", async () => {
    const preview = await getOutboundPreview(deliveryId);
    await query("UPDATE messages SET content_purged_at=now() WHERE service_id=$1",[serviceId]);
    await expect(readOutboundPreviewResource(deliveryId,"image_1",preview.revision,false)).rejects.toMatchObject({status:404});
    await expect(getOutboundPreview(deliveryId)).rejects.toMatchObject({status:404});
    await query("UPDATE messages SET content_policy='sensitive' WHERE service_id=$1",[serviceId]);
    await expect(getOutboundPreview(deliveryId)).rejects.toMatchObject({status:404});
  });
});
