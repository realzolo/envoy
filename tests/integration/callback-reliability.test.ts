import { createHmac } from "node:crypto";
import { sealSecret } from "@/modules/config/envelope";
import { replaceCallbackSecret, replayDeadLetters, toggleCallback } from "@/modules/admin/actions";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db, query } from "@/server/database";
import { createId } from "@/server/ids";
import { acceptMessage } from "@/modules/core/message/service";
import { createMessageSchema } from "@/lib/contracts";

const network = vi.hoisted(() => ({ resolve: vi.fn(), post: vi.fn() }));
vi.mock("@/modules/callbacks/url-policy", async importOriginal => {
  const original = await importOriginal<typeof import("@/modules/callbacks/url-policy")>();
  return { ...original, resolveCallbackTarget: network.resolve, postCallback: network.post };
});
import { deliverCallback } from "@/modules/callbacks/service";

const ids: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });
afterAll(async () => {
  await query("DELETE FROM outbox_events WHERE aggregate_type='callback' AND aggregate_id=ANY($1::text[])", [ids]);
  await query("DELETE FROM callback_deliveries WHERE id=ANY($1::text[])", [ids]);
  await db().end();
});

async function createCallback(attempts = 0) {
  const id = createId("cbx");
  ids.push(id);
  await query("INSERT INTO callback_deliveries(id,endpoint_id,event_type,payload,attempt_count) VALUES ($1,'cb_atlas_local','email.failed',$2,$3)", [id, { id: `event:${id}`, type: "email.failed" }, attempts]);
  return id;
}

describe("database-driven callback retry", () => {
  it("claims a delivery once and uses exactly the database retry timestamp for the outbox", async () => {
    const id = await createCallback();
    network.resolve.mockResolvedValue({});
    let finish!: (value: { status: number; statusText: string; body: string }) => void;
    network.post.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = deliverCallback(id);
    await vi.waitFor(() => expect(network.post).toHaveBeenCalledTimes(1));
    await deliverCallback(id);
    expect(network.post).toHaveBeenCalledTimes(1);
    finish({ status: 503, statusText: "Unavailable", body: "try later" });
    await first;
    const retry = (await query<{ status: string; attempt_count: number; next_attempt_at: Date; available_at: Date }>("SELECT d.status,d.attempt_count,d.next_attempt_at,o.available_at FROM callback_deliveries d JOIN outbox_events o ON o.aggregate_id=d.id AND o.event_type='callback.requested' WHERE d.id=$1", [id])).rows[0];
    expect(retry.status).toBe("retrying");
    expect(retry.attempt_count).toBe(1);
    expect(retry.available_at.getTime()).toBe(retry.next_attempt_at.getTime());
    await deliverCallback(id);
    expect(network.post).toHaveBeenCalledTimes(1);
    await query("UPDATE callback_deliveries SET next_attempt_at=now() WHERE id=$1", [id]);
    network.post.mockResolvedValue({ status: 200, statusText: "OK", body: "" });
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+61_000);
    try { await deliverCallback(id); } finally { clock.mockRestore(); }
    expect((await query<{ status: string; attempt_count: number }>("SELECT status,attempt_count FROM callback_deliveries WHERE id=$1", [id])).rows[0]).toEqual({ status: "delivered", attempt_count: 2 });
    expect(network.post.mock.calls.map(call => call[2]["x-envoy-id"])).toEqual([`event:${id}`, `event:${id}`]);
    expect(network.post.mock.calls[0][1]).toBe(network.post.mock.calls[1][1]);
    expect(network.post.mock.calls[0][2]["x-envoy-timestamp"]).not.toBe(network.post.mock.calls[1][2]["x-envoy-timestamp"]);
  });

  it("bounds retries and recovers an expired in-flight claim", async () => {
    const id = await createCallback(9);
    await query("UPDATE callback_deliveries SET status='delivering',updated_at=now()-interval '3 minutes' WHERE id=$1", [id]);
    network.resolve.mockResolvedValue({});
    network.post.mockRejectedValue(new Error("connection reset"));
    await deliverCallback(id);
    expect((await query<{ status: string; attempt_count: number }>("SELECT status,attempt_count FROM callback_deliveries WHERE id=$1", [id])).rows[0]).toEqual({ status: "dead_letter", attempt_count: 10 });
    expect((await query<{ count: string }>("SELECT count(*) FROM outbox_events WHERE aggregate_id=$1", [id])).rows[0].count).toBe("0");
  });

  it("rechecks frozen message domain permissions after callback DNS resolution",async()=>{
    const message=(await acceptMessage({identity:{serviceId:"svc_atlas_auth",serviceName:"Atlas Auth",productId:"prd_atlas",product:"Atlas",rateLimitPerMinute:600},
      input:createMessageSchema.parse({from:{email:"help@mail.atlas.test"},to:[{email:"customer@example.net"}],category:"security",subject:"Domain permission race",text:"Body"}),idempotencyKey:crypto.randomUUID()})).message.id;
    const delivery=(await query<{id:string}>("SELECT id FROM deliveries WHERE message_id=$1",[message])).rows[0].id,event=createId("dev"),callback=await createCallback();
    await query("INSERT INTO delivery_events(id,delivery_id,event_type,occurred_at,canonical_payload,source_key) VALUES($1,$2,'failed',now(),'{}',$1)",[event,delivery]);
    await query("UPDATE callback_deliveries SET delivery_event_id=$2 WHERE id=$1",[callback,event]);
    network.resolve.mockImplementation(async()=>{await query("UPDATE service_domain_grants SET status='disabled' WHERE id='sg_atlas'");return {};});
    network.post.mockResolvedValue({status:200,statusText:"OK",body:""});
    try{
      await deliverCallback(callback);
      expect(network.post).not.toHaveBeenCalled();
      expect((await query("SELECT status FROM callback_deliveries WHERE id=$1",[callback])).rows[0].status).toBe("dead_letter");
    }finally{
      await query("UPDATE service_domain_grants SET status='active' WHERE id='sg_atlas'");
      await query("DELETE FROM callback_deliveries WHERE id=$1",[callback]);
      await query("DELETE FROM messages WHERE id=$1",[message]);
    }
  });
});

it("replaces one callback secret only after pausing and draining in-flight requests",async()=>{
  const endpoint=createId("callback"),first=createId("cbx"),second=createId("cbx");
  const service=createId("svc");await query("INSERT INTO services(id,product_id,name) VALUES($1,'prd_atlas',$1)",[service]);
  const oldSecret="old-callback-test-key",newSecret="new-callback-test-key";
  const envelope=sealSecret({secret:oldSecret},endpoint,1);
  await query("INSERT INTO callback_endpoints(id,service_id,name,url,secret_ciphertext,encrypted_dek,key_version,subscribed_events) VALUES($1,$5,'single secret','https://callback.test/events',$2,$3,$4,ARRAY['email.failed'])",[endpoint,envelope.secretCiphertext,envelope.encryptedDek,envelope.keyVersion,service]);
  try {
    for(const id of [first,second]) await query("INSERT INTO callback_deliveries(id,endpoint_id,event_type,payload) VALUES($1,$2,'email.failed',$3)",[id,endpoint,{id,type:"email.failed",apiVersion:"2026-09-01"}]);
    await expect(replaceCallbackSecret(endpoint,newSecret,"test")).rejects.toThrow("Disable callback delivery");
    network.resolve.mockResolvedValue({});let finish!:(value:unknown)=>void;
    network.post.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const inflight=deliverCallback(first);await vi.waitFor(()=>expect(network.post).toHaveBeenCalledTimes(1));
    await toggleCallback(endpoint,false,"test");
    expect((await query("SELECT status FROM callback_deliveries WHERE id=$1",[first])).rows[0].status).toBe("delivering");
    await expect(replaceCallbackSecret(endpoint,newSecret,"test")).rejects.toThrow("in-flight callback deliveries");
    await deliverCallback(second);expect(network.post).toHaveBeenCalledTimes(1);
    finish({status:202,statusText:"Accepted",body:""});await inflight;
    await query("UPDATE callback_deliveries SET status='delivering',updated_at=now()-interval '3 minutes' WHERE id=$1",[second]);
    await expect(replaceCallbackSecret(endpoint,newSecret,"test")).rejects.toThrow("in-flight callback deliveries");
    await deliverCallback(second);expect(network.post).toHaveBeenCalledTimes(1);
    expect((await query("SELECT status FROM callback_deliveries WHERE id=$1",[second])).rows[0].status).toBe("dead_letter");
    expect(await replaceCallbackSecret(endpoint,newSecret,"test")).toEqual({secret:newSecret});
    await toggleCallback(endpoint,true,"test");
    expect(await replayDeadLetters("test",{deliveryId:second})).toBe(1);
    network.post.mockResolvedValue({status:202,statusText:"Accepted",body:""});await deliverCallback(second);
    for(const [index,secret] of [oldSecret,newSecret].entries()) {
      const [,body,headers]=network.post.mock.calls[index];
      const expected=createHmac("sha256",secret).update(`${headers["x-envoy-timestamp"]}.${body}`).digest("hex");
      expect(headers["x-envoy-signature"]).toBe(`v1=${expected}`);
      expect(Object.keys(headers).sort()).toEqual(["content-type","x-envoy-id","x-envoy-signature","x-envoy-timestamp"]);
      expect(JSON.parse(body).apiVersion).toBe("2026-09-01");
    }
    const audit=JSON.stringify((await query("SELECT details FROM audit_logs WHERE resource_id=$1 AND action='callback_endpoint.replace_secret'",[endpoint])).rows);
    expect(audit).not.toContain(newSecret);
  }finally{await query("DELETE FROM outbox_events WHERE aggregate_type='callback' AND aggregate_id=ANY($1::text[])",[[first,second]]);await query("DELETE FROM callback_deliveries WHERE endpoint_id=$1",[endpoint]);await query("DELETE FROM callback_endpoints WHERE id=$1",[endpoint]);await query("DELETE FROM services WHERE id=$1",[service]);}
});
