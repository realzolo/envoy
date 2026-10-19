import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { db, query } from "@/platform/database";
import { createId } from "@/platform/ids";
import { listOutboundChanges } from "@/modules/outbound/public";
import { GET as changesAPI } from "@/app/api/v1/outbound-changes/route";
import { GET as openAPI } from "@/app/api/v1/openapi.json/route";
import { outboundChangePageSchema } from "@/lib/contracts";
import { hashApiKey } from "@/platform/crypto/hash";
import { runRetention } from "@/platform/retention/public";

const tag = createId("stream"), service = `svc_${tag}`, other = `svc_other_${tag}`, domain = `sd_${tag}`;
const key = `envoy_${tag}`, message = `msg_${tag}`, second = `msg_second_${tag}`;
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
const request = (cursor: string) => new Request(`https://envoy.test/api/v1/outbound-changes?cursor=${encodeURIComponent(cursor)}`, { headers: { authorization: `Bearer ${key}` } });
async function append(id = createId("evt"), options: { client?: PoolClient; occurredAt?: string; submission?: boolean; messageId?: string } = {}) {
  const table = options.submission ? "submission_events" : "delivery_events", column = options.submission ? "submission_id" : "delivery_id";
  const statement = `INSERT INTO ${table}(id,${column},event_type,source_key,occurred_at,canonical_payload) VALUES($1,$2,'delivered',$1,$3,'{}') ON CONFLICT DO NOTHING`;
  const values = [id, options.submission ? `sub_${tag}` : options.messageId ?? message, options.occurredAt ?? new Date().toISOString()];
  if (options.client) await options.client.query(statement, values); else await query(statement, values);
  return id;
}

beforeAll(async () => {
  for (const id of [service, other]) await query("INSERT INTO services(id,name) VALUES($1,$1)", [id]);
  await query("INSERT INTO sending_domains(id,domain) VALUES($1,$2)", [domain, `${tag}.test`]);
  await query("INSERT INTO service_domain_grants(id,service_id,sending_domain_id,send_allowed) VALUES($1,$2,$3,true)", [`grant_${tag}`, service, domain]);
  await query("INSERT INTO service_credentials(id,service_id,key_prefix,key_hash) VALUES($1,$2,'stream',$3)", [`cred_${tag}`, service, hashApiKey(key)]);
  for (const id of [message, second]) {
    await query(`INSERT INTO messages(id,service_id,sending_domain_id,sender_snapshot,idempotency_key,payload_hash,recipient_count,subject,text_body,message_category)
      VALUES($1,$2,$3,'{"fromEmail":"sender@example.test"}',$1,'hash',1,'subject','body','security')`, [id, service, domain]);
    await query("INSERT INTO deliveries(id,message_id,recipient_email,recipient_role) VALUES($1,$1,'recipient@example.test','to')", [id]);
  }
  await query("INSERT INTO submissions(id,message_id) VALUES($1,$2)", [`sub_${tag}`, message]);
});
afterAll(async () => {
  await query("DELETE FROM messages WHERE service_id=$1", [service]);
  await query("DELETE FROM services WHERE id=ANY($1)", [[service, other]]);
  await query("DELETE FROM sending_domains WHERE id=$1", [domain]);
  await db().end();
});

describe("outbound committed change stream", () => {
  it("returns a resumable empty page and discovers a later event with an earlier occurrence time", async () => {
    const before = await listOutboundChanges(service, 1);
    expect(before.data).toEqual([]); expect(before.nextCursor).toBe(before.watermark);
    const id = await append(undefined, { occurredAt: "1900-01-01T00:00:00Z" });
    const page = await listOutboundChanges(service, 1, before.nextCursor);
    expect(page.data.map(row => row.id)).toEqual([id]); expect(page.data[0].messageId).toBe(message);
    expect(Date.parse(page.data[0].recordedAt)).toBeGreaterThan(Date.now() - 10_000);
    expect(outboundChangePageSchema.safeParse(page).success).toBe(true);
    expect(await listOutboundChanges(service, 1, before.nextCursor)).toEqual(page);
    expect((await listOutboundChanges(service, 1, page.nextCursor)).data).toEqual([]);
  });
  it("includes submission events and makes duplicate event inserts idempotent", async () => {
    const before = await listOutboundChanges(service, 100), id = await append(undefined, { submission: true });
    await append(id, { submission: true });
    const page = await listOutboundChanges(service, 100, before.nextCursor);
    expect(page.data.map(row => row.id)).toEqual([id]); expect(page.data[0].messageId).toBe(message);
  });
  it("pages numerically across concurrent appends without rescanning history", async () => {
    const before = await listOutboundChanges(service, 100), expected = [];
    for (let i = 0; i < 24; i++) expected.push(await append());
    const first = await listOutboundChanges(service, 3, before.nextCursor); expect(first.hasMore).toBe(true);
    expected.push(await append(undefined, { occurredAt: "1800-01-01T00:00:00Z" }));
    const seen = first.data.map(row => row.id); let cursor = first.nextCursor;
    for (let i = 0; i < 10; i++) {
      const page = await listOutboundChanges(service, 3, cursor); seen.push(...page.data.map(row => row.id)); cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(seen).toEqual(expected); expect((await listOutboundChanges(service, 3, cursor)).data).toEqual([]);
  });
  it("waits for in-flight commits and cannot publish a cursor past uncommitted positions", async () => {
    const before = await listOutboundChanges(service, 100), x = await db().connect(), y = await db().connect();
    try {
      await x.query("BEGIN"); await y.query("BEGIN");
      const first = await append(undefined, { client: x });
      let written = false, read = false;
      const secondId = createId("evt");
      const secondWrite = append(secondId, { client: y, messageId: second }).then(() => { written = true; });
      await pause(); expect(written).toBe(false);
      const reading = listOutboundChanges(service, 100, before.nextCursor).then(value => { read = true; return value; });
      await pause(); expect(read).toBe(false);
      await x.query("COMMIT"); await secondWrite; await y.query("COMMIT");
      const page = await reading;
      const remaining = await listOutboundChanges(service, 100, page.nextCursor);
      expect([...page.data, ...remaining.data].map(row => row.id)).toEqual([first, secondId]);
    } finally { await x.query("ROLLBACK"); await y.query("ROLLBACK"); x.release(); y.release(); }
  });
  it("rolls back an allocated position before another writer can publish", async () => {
    const before = await listOutboundChanges(service, 100), x = await db().connect(), y = await db().connect();
    try {
      await x.query("BEGIN"); await y.query("BEGIN"); await append(undefined, { client: x });
      const id = createId("evt"), writing = append(id, { client: y, messageId: second });
      await pause(); await x.query("ROLLBACK"); await writing; await y.query("COMMIT");
      expect((await listOutboundChanges(service, 100, before.nextCursor)).data.map(row => row.id)).toEqual([id]);
    } finally { await x.query("ROLLBACK"); await y.query("ROLLBACK"); x.release(); y.release(); }
  });
  it("advances an authorization-filtered empty tail and keeps Service cursors isolated", async () => {
    const before = await listOutboundChanges(service, 100); await append();
    await query("UPDATE service_domain_grants SET status='disabled' WHERE service_id=$1", [service]);
    try {
      const page = await listOutboundChanges(service, 100, before.nextCursor);
      expect(page.data).toEqual([]); expect(page.nextCursor).toBe(page.watermark); expect(page.nextCursor).not.toBe(before.nextCursor);
      expect((await listOutboundChanges(other, 100)).data).toEqual([]);
      await expect(listOutboundChanges(other, 100, page.nextCursor)).rejects.toMatchObject({ code: "INVALID_OUTBOUND_CURSOR", resetCursor: expect.any(String) });
      await query("UPDATE service_domain_grants SET status='active' WHERE service_id=$1", [service]);
      const id = await append();
      expect((await listOutboundChanges(service, 100, page.nextCursor)).data.map(row => row.id)).toEqual([id]);
    } finally { await query("UPDATE service_domain_grants SET status='active' WHERE service_id=$1", [service]); }
  });
  it("returns usable reset cursors for malformed and future cursors over HTTP", async () => {
    const page = await listOutboundChanges(service, 100);
    const future = { ...JSON.parse(Buffer.from(page.nextCursor, "base64url").toString()), position: "9223372036854775807" };
    for (const value of [null, [], {}, "value", { service, position: "-1" }, { service, position: "0" }, { service, generation: 1, position: "0" }, future]) {
      const response = await changesAPI(request(Buffer.from(JSON.stringify(value)).toString("base64url")));
      expect(response.status).toBe(400);
      const body = await response.json(); expect(body).toMatchObject({ code: "INVALID_OUTBOUND_CURSOR", errors: { resetCursor: expect.any(String) } });
      await expect(listOutboundChanges(service, 100, body.errors.resetCursor)).resolves.toBeDefined();
    }
  });
  it("bounds oversized cursor input and includes a reset cursor", async () => {
    const response = await changesAPI(request("x".repeat(1025)));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "INVALID_OUTBOUND_CURSOR", errors: { resetCursor: expect.any(String) } });
  });
  it("reports replaced stream generations as a gap with a reset cursor", async () => {
    const before = await listOutboundChanges(service, 100), parsed = JSON.parse(Buffer.from(before.nextCursor, "base64url").toString());
    const response = await changesAPI(request(Buffer.from(JSON.stringify({ ...parsed, generation: "another" })).toString("base64url")));
    expect(response.status).toBe(410); expect(await response.json()).toMatchObject({ code: "OUTBOUND_CURSOR_EXPIRED", errors: { resetCursor: expect.any(String), gap: true } });
  });
  it("prunes only an expired prefix and preserves a non-expired boundary despite clock disorder", async () => {
    const before = await listOutboundChanges(service, 100), fresh = await append(), late = await append();
    await query("UPDATE outbound_changes SET recorded_at=now()-interval '91 days' WHERE service_id=$1 AND id<>$2", [service, fresh]);
    await runRetention({ apply: true, batchSize: 100, days: {} }, { put: vi.fn(), get: vi.fn(), delete: vi.fn() });
    const expired = await changesAPI(request(before.retention.earliestCursor)); expect(expired.status).toBe(410);
    const error = await expired.json(); expect(error).toMatchObject({ code: "OUTBOUND_CURSOR_EXPIRED", errors: { gap: true, resetCursor: expect.any(String) } });
    const retained = await listOutboundChanges(service, 100, error.errors.resetCursor);
    expect(retained.data.map(row => row.id)).toEqual([fresh, late]); expect(retained.retention).toMatchObject({ historyTruncated: true, days: 90 });
    await query("UPDATE outbound_changes SET recorded_at=now()-interval '91 days' WHERE service_id=$1", [service]);
    await runRetention({ apply: true, batchSize: 100, days: {} }, { put: vi.fn(), get: vi.fn(), delete: vi.fn() });
    const empty = await listOutboundChanges(service, 100); expect(empty.data).toEqual([]); expect(empty.nextCursor).toBe(empty.watermark);
    const id = await append(); expect((await listOutboundChanges(service, 100, empty.nextCursor)).data.map(row => row.id)).toEqual([id]);
  });
  it("publishes the stream page and errors in OpenAPI", async () => {
    const document = await openAPI(new Request("https://envoy.test/api/v1/openapi.json")).json();
    expect(document.paths["/outbound-changes"].get.responses["410"]).toBeDefined();
    expect(document.components.schemas.OutboundChangePage.required).toEqual(expect.arrayContaining(["data", "nextCursor", "hasMore", "watermark", "retention"]));
  });
});
