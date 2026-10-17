import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db, query } from "@/server/database";
import { createId } from "@/server/ids";

const network = vi.hoisted(() => ({ resolve: vi.fn(), post: vi.fn() }));
vi.mock("@/modules/callbacks/url-policy", async importOriginal => {
  const original = await importOriginal<typeof import("@/modules/callbacks/url-policy")>();
  return { ...original, resolveCallbackTarget: network.resolve, postCallback: network.post };
});
import { deliverCallback } from "@/modules/callbacks/service";

const ids: string[] = [];
afterEach(() => vi.resetAllMocks());
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
    await deliverCallback(id);
    expect((await query<{ status: string; attempt_count: number }>("SELECT status,attempt_count FROM callback_deliveries WHERE id=$1", [id])).rows[0]).toEqual({ status: "delivered", attempt_count: 2 });
    expect(network.post.mock.calls.map(call => call[2]["x-envoy-id"])).toEqual([`event:${id}`, `event:${id}`]);
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
});
