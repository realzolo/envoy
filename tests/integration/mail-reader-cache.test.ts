import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, query, transaction, transactionContext } from "@/platform/database";
import { persistInbound } from "@/modules/inbound/public";
import { digest } from "@/modules/attachments/public";
import { readerCache } from "@/modules/mail-reader/infrastructure/cache.repository";
import type { ReaderCacheIdentity } from "@/modules/mail-reader/cache-contracts";
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWooAAAAASUVORK5CYII=", "base64");
afterAll(async () => { await db().end(); });
async function seed(): Promise<ReaderCacheIdentity> {
  const id = await persistInbound({ providerAccountId: "pa_mock", webhookEndpointId: "pwe_mock", rawEventId: null!,
    message: { externalMessageId: `reader-${randomUUID()}`, from: "sender@example.test", to: ["inbox@mail.atlas.test"], cc: [], bcc: [], subject: "Reader cache fixture",
      html: "<p>Original source</p>", text: "Original text", textProvenance: "AUTHORED", attachments: [], envelopeRecipients: ["inbox@mail.atlas.test"], receivedAt: new Date() } });
  return { kind: "INBOUND", id, revision: "a".repeat(64), resourceId: "resource_1" };
}
async function seedOutbound():Promise<{key:ReaderCacheIdentity;messageId:string}> {
  const suffix=randomUUID(),messageId=`msg_reader_${suffix}`,deliveryId=`delivery_reader_${suffix}`;
  await query(`INSERT INTO messages(id,service_id,sending_domain_id,sender_snapshot,idempotency_key,payload_hash,recipient_count,subject,text_body,message_category)
    VALUES($1,'svc_atlas_auth','sd_atlas','{}',$2,'hash',1,'Original outbound subject','Original outbound text','security')`,[messageId,suffix]);
  await query("INSERT INTO deliveries(id,message_id,recipient_email,recipient_role) VALUES($1,$2,'reader@example.test','to')",[deliveryId,messageId]);
  return {key:{kind:"OUTBOUND",id:deliveryId,revision:"a".repeat(64),resourceId:"resource_1"},messageId};
}
async function demand(key:ReaderCacheIdentity,serviceId:string|null) {
  const row=(await query<{value:string}>("SELECT updated_at::text AS value FROM mail_reader_resources WHERE source_kind=$1 AND source_id=$2 AND source_revision=$3 AND resource_id=$4",[key.kind,key.id,key.revision,key.resourceId])).rows[0];
  return {...key,serviceId,updatedAt:row.value};
}
const image = () => ({ bytes, contentType: "image/png", sha256: digest(bytes) });
describe("unified reader durable cache", () => {
  it("prepares once across competing consumers and caches encrypted original bytes independently of capability lifetime", async () => {
    const key = await seed();
    await Promise.all([readerCache.enqueue(key, "svc_atlas_auth"), readerCache.enqueue(key, "svc_atlas_auth")]);
    const claims = await Promise.all([readerCache.claim(key), readerCache.claim(key)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    expect(await readerCache.store(key, claim.token, image())).toBe(true);
    expect(await readerCache.claim(key)).toBeNull();
    expect(await readerCache.get(key)).toMatchObject({ state: "READY", contentType: "image/png", size: bytes.length, sha256: digest(bytes) });
    expect(Buffer.from((await readerCache.get(key))!.bytes!)).toEqual(bytes);
    expect((await readerCache.get(key, false))!.bytes).toBeUndefined();
    const row = (await query<{cached_content:unknown}>("SELECT cached_content FROM mail_reader_resources WHERE source_id=$1", [key.id])).rows[0];
    expect(JSON.stringify(row.cached_content)).not.toContain(bytes.toString("base64"));
    expect(JSON.stringify(row.cached_content)).toContain("secretCiphertext");
  });
  it("erasure atomically removes cache work and fences a late publisher", async () => {
    const key = await seed(); await readerCache.enqueue(key, null);
    const claim = (await readerCache.claim(key))!;
    await query("UPDATE inbound_messages SET content_purged_at=clock_timestamp() WHERE id=$1", [key.id]);
    expect(await readerCache.store(key, claim.token, image())).toBe(false);
    expect(await readerCache.get(key)).toBeNull();
    await readerCache.enqueue(key, null);
    expect((await query("SELECT 1 FROM mail_reader_resources WHERE source_id=$1", [key.id])).rowCount).toBe(0);
  });
  it("persists retry waits and exhausts crashed leases without restarting the same job", async () => {
    const key = await seed(); await readerCache.enqueue(key, "svc_atlas_auth");
    let claim = (await readerCache.claim(key))!;
    await readerCache.fail(key, claim.token, "FETCH_FAILED", true);
    expect(await readerCache.get(key)).toMatchObject({state:"RETRY_WAIT",reasonCode:"FETCH_FAILED"});
    expect(await readerCache.claim(key)).toBeNull();
    await query("UPDATE mail_reader_resources SET available_at=clock_timestamp()-interval '1 second' WHERE source_id=$1", [key.id]);
    claim = (await readerCache.claim(key))!;
    expect(await readerCache.store(key, "wrong-lease", image())).toBe(false);
    await readerCache.fail(key, claim.token, "FETCH_FAILED", true);
    await query("UPDATE mail_reader_resources SET available_at=clock_timestamp()-interval '1 second' WHERE source_id=$1", [key.id]);
    expect(await readerCache.claim(key)).not.toBeNull();
    await query("UPDATE mail_reader_resources SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE source_id=$1", [key.id]);
    await readerCache.pending();
    expect(await readerCache.get(key)).toMatchObject({state:"UNAVAILABLE",reasonCode:"RETRY_EXHAUSTED"});
    await readerCache.enqueue(key, "svc_atlas_auth");
    expect(await readerCache.claim(key)).toBeNull();
  });
  it("cancels only unauthorized unfinished demand and preserves ready bytes", async () => {
    const key = await seed();
    await readerCache.enqueue(key, "svc_atlas_auth");
    await readerCache.cancelUnauthorizedDemand(await demand(key,null));
    expect(await readerCache.get(key,false)).not.toBeNull();
    await readerCache.cancelUnauthorizedDemand(await demand(key,"svc_atlas_auth"));
    expect(await readerCache.get(key,false)).toBeNull();
    await readerCache.enqueue(key, "svc_atlas_auth");
    const claim = (await readerCache.claim(key))!;
    await readerCache.store(key,claim.token,image());
    await readerCache.cancelUnauthorizedDemand(await demand(key,"svc_atlas_auth"));
    expect(await readerCache.get(key,false)).toMatchObject({state:"READY"});
  });
  it("defers source recovery before claim with a finite budget instead of polling indefinitely", async () => {
    const key = await seed();
    await readerCache.enqueue(key,"svc_atlas_auth");
    for(let attempt=1;attempt<=3;attempt++) {
      await readerCache.deferPreparationDemand(await demand(key,"svc_atlas_auth"));
      const row=(await query<{attempt_count:number;state:string}>("SELECT attempt_count,state FROM mail_reader_resources WHERE source_id=$1",[key.id])).rows[0];
      expect(row.attempt_count).toBe(attempt);
      expect(row.state).toBe(attempt<3?"RETRY_WAIT":"UNAVAILABLE");
      await readerCache.deferPreparationDemand(await demand(key,"svc_atlas_auth"));
      expect((await query<{attempt_count:number}>("SELECT attempt_count FROM mail_reader_resources WHERE source_id=$1",[key.id])).rows[0].attempt_count).toBe(attempt);
      await query("UPDATE mail_reader_resources SET available_at=clock_timestamp()-interval '1 second' WHERE source_id=$1",[key.id]);
    }
    expect(await readerCache.claim(key)).toBeNull();
  });
  it("serializes publication at the document byte ceiling and rejects oversized single images", async () => {
    const key = await seed();
    const left={...key,resourceId:"last_a"},right={...key,resourceId:"last_b"};
    for(let index=0;index<5;index++) {
      await query(`INSERT INTO mail_reader_resources(source_kind,source_id,source_revision,resource_id,state,cached_content,content_type,size_bytes,sha256)
        VALUES('INBOUND',$1,$2,$3,'READY','{}','image/png',$4,$5)`,[key.id,key.revision,`reserved_${index}`,20_000_000-(index===4?bytes.length:0),"b".repeat(64)]);
    }
    await Promise.all([readerCache.enqueue(left,null),readerCache.enqueue(right,null)]);
    const a=(await readerCache.claim(left))!,b=(await readerCache.claim(right))!;
    const published=await Promise.all([readerCache.store(left,a.token,image()),readerCache.store(right,b.token,image())]);
    expect(published.filter(Boolean)).toHaveLength(1);
    expect((await query<{total:string}>("SELECT sum(size_bytes)::text AS total FROM mail_reader_resources WHERE source_id=$1 AND state='READY'",[key.id])).rows[0].total).toBe("100000000");
    expect(await readerCache.store(right,b.token,{...image(),bytes:Buffer.alloc(20_000_001)})).toBe(false);
  });
  it("audits explicit retries, leaves ordinary reopening terminal and deduplicates operation replays", async () => {
    const key=await seed();await readerCache.enqueue(key,"svc_atlas_auth");
    const claim=(await readerCache.claim(key))!;
    await readerCache.fail(key,claim.token,"READING_FETCH_FAILED",false);
    await readerCache.enqueue(key,"svc_atlas_auth");
    expect(await readerCache.claim(key)).toBeNull();
    const operation=randomUUID();
    expect(await readerCache.retryFailed(key,"svc_atlas_auth",operation)).toBe(1);
    expect(await readerCache.retryFailed(key,"svc_atlas_auth",operation)).toBe(0);
    expect(await readerCache.get(key,false)).toMatchObject({state:"PENDING",reasonCode:null});
    const audit=(await query<{details:{resources:{attemptCount:number;reasonCode:string}[]}}>("SELECT details FROM audit_logs WHERE action='mail_reader.retry_requested' AND resource_id=$1",[operation])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].details.resources[0]).toMatchObject({attemptCount:1,reasonCode:"READING_FETCH_FAILED"});
    const other=await seed();
    await expect(readerCache.retryFailed(other,"svc_atlas_auth",operation)).rejects.toThrow("scope changed");
  });

  it("does not let a late unauthorized worker delete demand from an explicit retry generation", async () => {
    const key=await seed();await readerCache.enqueue(key,"svc_atlas_auth");
    const stale=await demand(key,"svc_atlas_auth");
    const claim=(await readerCache.claim(key))!;
    await readerCache.fail(key,claim.token,"READING_FETCH_FAILED",false);
    await readerCache.retryFailed(key,"svc_atlas_auth",randomUUID());
    await readerCache.cancelUnauthorizedDemand(stale);
    expect(await readerCache.get(key,false)).toMatchObject({state:"PENDING"});
  });
  it("lets a newly authorized scope explicitly retry media failure while preserving prior scope in audit", async () => {
    const key=await seed();await readerCache.enqueue(key,"svc_atlas_auth");
    const claim=(await readerCache.claim(key))!;
    await readerCache.fail(key,claim.token,"READING_FETCH_FAILED",false);
    const operation=randomUUID();
    const retries=await Promise.all([readerCache.retryFailed(key,null,operation),readerCache.retryFailed(key,null,operation)]);
    expect(retries.sort()).toEqual([0,1]);
    expect((await query<{service_id:string|null}>("SELECT service_id FROM mail_reader_resources WHERE source_id=$1",[key.id])).rows[0].service_id).toBeNull();
    const audit=(await query<{details:{resources:{priorServiceId:string}[]}}>("SELECT details FROM audit_logs WHERE action='mail_reader.retry_requested' AND resource_id=$1",[operation])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].details.resources[0].priorServiceId).toBe("svc_atlas_auth");
  });

  it("erases outbound cache on either message content purge or source delivery deletion", async () => {
    const first=await seedOutbound();await readerCache.enqueue(first.key,null);
    const claim=(await readerCache.claim(first.key))!;
    expect(await readerCache.store(first.key,claim.token,image())).toBe(true);
    await query("UPDATE messages SET content_purged_at=clock_timestamp() WHERE id=$1",[first.messageId]);
    expect(await readerCache.get(first.key)).toBeNull();
    const second=await seedOutbound();await readerCache.enqueue(second.key,null);
    const late=(await readerCache.claim(second.key))!;
    await query("DELETE FROM deliveries WHERE id=$1",[second.key.id]);
    expect(await readerCache.store(second.key,late.token,image())).toBe(false);
    expect((await query("SELECT 1 FROM mail_reader_resources WHERE source_id=$1",[second.key.id])).rowCount).toBe(0);
  });

  it("registers preparation demand in the caller's source transaction and rolls it back with that source", async () => {
    const key=await seed();
    await expect(transaction(async client=>{
      await readerCache.enqueue(key,null,transactionContext(client));
      expect((await client.query("SELECT 1 FROM mail_reader_resources WHERE source_id=$1",[key.id])).rowCount).toBe(1);
      throw new Error("Rollback fixture source transaction");
    })).rejects.toThrow("Rollback fixture");
    expect(await readerCache.get(key,false)).toBeNull();
  });

});
