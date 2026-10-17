import { afterEach, describe, expect, it, vi } from "vitest";
import { query, transaction } from "@/server/database";
import { completeObjectUploads, registerObjectUpload } from "@/server/services/object-cleanup";
import { createId } from "@/server/ids";
import { retentionOptions, runRetention } from "@/server/services/retention";
import type { ObjectStore } from "@/modules/config/object-store";

const created: { messages: string[]; raw: string[]; inbound: string[]; callbacks: string[]; audits: string[] } = { messages: [], raw: [], inbound: [], callbacks: [], audits: [] };
const store = (): ObjectStore => ({ put: vi.fn(), get: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) });
const options = (apply: boolean) => ({ apply, batchSize: 100, days: { messages: 3650, rawEvents: 3650, inbound: 3650, callbacks: 3650, auditDetails: 3650 } });

async function message(status: string) {
  const id = createId("retention");
  created.messages.push(id);
  await query(`INSERT INTO messages(id,product_id,service_id,sender_profile_id,sender_snapshot,idempotency_key,payload_hash,recipient_count,subject,text_body,message_category,accepted_at)
    VALUES ($1,'prd_atlas','svc_atlas_auth','sp_atlas_security','{"fromEmail":"security@mail.atlas.test"}',$1,'original-fingerprint',1,'Private subject','Private body','security',now()-interval '4000 days')`, [id]);
  await query("INSERT INTO deliveries(id,message_id,recipient_email,lifecycle_status) VALUES ($1,$1,'retention@example.test',$2)", [id, status]);
  return id;
}

afterEach(async () => {
  for (const id of created.callbacks.splice(0)) await query("DELETE FROM callback_deliveries WHERE id=$1", [id]);
  for (const id of created.messages.splice(0)) await query("DELETE FROM messages WHERE id=$1", [id]);
  for (const id of created.inbound.splice(0)) await query("DELETE FROM inbound_messages WHERE id=$1", [id]);
  for (const id of created.raw.splice(0)) await query("DELETE FROM raw_provider_events WHERE id=$1", [id]);
  for (const id of created.audits.splice(0)) await query("DELETE FROM audit_logs WHERE id=$1", [id]);
});

describe("bounded content retention", () => {
  it("defaults to dry-run and disables cleanup without an explicit deployment policy", () => {
    expect(retentionOptions({})).toEqual({ apply: false, batchSize: 100, days: {} });
    expect(() => retentionOptions({ ENVOY_RETENTION_CONTENT_DAYS: "-1" })).toThrow();
    expect(() => retentionOptions({ ENVOY_RETENTION_BATCH_SIZE: "1000000" })).toThrow();
  });

  it("preserves active/unknown messages and the idempotency receipt after terminal content expires", async () => {
    const done = await message("delivered");
    const unknown = await message("unknown");
    const queued = await message("queued");
    const fakeStore = store();
    const dry = await runRetention(options(false), fakeStore);
    expect(dry.messages.eligible).toBe(1);
    expect(dry.messages.applied).toBe(0);
    expect((await query<{ subject: string }>("SELECT subject FROM messages WHERE id=$1", [done])).rows[0].subject).toBe("Private subject");
    const first = await runRetention(options(true), fakeStore);
    expect(first.messages.applied).toBe(1);
    const row = (await query<{ subject: string; payload_hash: string; idempotency_key: string; sender_snapshot: unknown; content_purged_at: Date }>("SELECT * FROM messages WHERE id=$1", [done])).rows[0];
    expect(row).toMatchObject({ subject: "", payload_hash: "original-fingerprint", idempotency_key: done, sender_snapshot: { fromEmail: "security@mail.atlas.test" } });
    expect(row.content_purged_at).toBeInstanceOf(Date);
    expect((await query("SELECT id FROM messages WHERE id=ANY($1::text[]) AND content_purged_at IS NULL", [[unknown, queued]])).rowCount).toBe(2);
    expect((await runRetention(options(true), fakeStore)).messages.applied).toBe(0);
  });

  it("keeps terminal message content while a callback still requires delivery or replay", async () => {
    const id = await message("failed");
    const event = createId("evt");
    const callback = createId("retentioncb");
    created.callbacks.push(callback);
    await query("INSERT INTO delivery_events(id,delivery_id,event_type,source_key,occurred_at,canonical_payload) VALUES ($1,$2,'failed',$1,now(),'{}')", [event, id]);
    await query("INSERT INTO callback_deliveries(id,endpoint_id,delivery_event_id,event_type,payload,status) VALUES ($1,'cb_atlas_local',$2,'email.failed','{}','dead_letter')", [callback, event]);
    expect((await runRetention(options(true), store())).messages.applied).toBe(0);
    expect((await query("SELECT id FROM messages WHERE id=$1 AND content_purged_at IS NULL", [id])).rowCount).toBe(1);
  });

  it("retries object deletion failures without discarding the raw event reference", async () => {
    const id = createId("retentionraw");
    created.raw.push(id);
    await query(`INSERT INTO raw_provider_events(id,provider_account_id,webhook_endpoint_id,native_type,signature_valid,replay_valid,raw_body,raw_object_key,headers,received_at,processed_at)
      VALUES ($1,'pa_mock','pwe_mock','delivered',true,true,$2,'retention/raw','{}',now()-interval '4000 days',now()-interval '4000 days')`, [id, Buffer.from("private raw")]);
    const fakeStore = store();
    vi.mocked(fakeStore.delete).mockRejectedValueOnce(new Error("storage unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await runRetention(options(false), fakeStore)).rawEvents.eligible).toBe(1);
      expect(fakeStore.delete).not.toHaveBeenCalled();
      expect((await runRetention(options(true), fakeStore)).rawEvents.failed).toBe(1);
      const failed = (await query<{ raw_object_key: string; content_purged_at: Date | null }>("SELECT raw_object_key,content_purged_at FROM raw_provider_events WHERE id=$1", [id])).rows[0];
      expect(failed).toEqual({ raw_object_key: "retention/raw", content_purged_at: null });
      expect((await runRetention(options(true), fakeStore)).rawEvents.applied).toBe(1);
      expect((await query("SELECT id FROM raw_provider_events WHERE id=$1 AND raw_body IS NULL AND raw_object_key IS NULL AND content_purged_at IS NOT NULL", [id])).rowCount).toBe(1);
      expect((await runRetention(options(true), fakeStore)).rawEvents.applied).toBe(0);
      expect(fakeStore.delete).toHaveBeenCalledTimes(2);
    } finally { log.mockRestore(); }
  });

  it("deletes inbound objects before marking metadata expired, and retains audit identity", async () => {
    const id = createId("retentionin");
    created.inbound.push(id);
    await query(`INSERT INTO inbound_messages(id,provider_account_id,from_email,to_emails,subject,text_body,raw_mime_object_key,status,received_at)
      VALUES ($1,'pa_mock','sender@example.test','{recipient@example.test}','Private inbound','Private body','retention/mime','ready',now()-interval '4000 days')`, [id]);
    await query("INSERT INTO inbound_attachments(id,inbound_message_id,file_name,content_type,size_bytes,object_key,scan_status) VALUES ($1,$1,'file.txt','text/plain',12,'retention/attachment','clean')", [id]);
    const audit = await query<{ id: string }>("INSERT INTO audit_logs(actor,action,resource_type,resource_id,details,created_at) VALUES ('admin','update','provider','pa_mock','{\"private\":true}',now()-interval '4000 days') RETURNING id::text");
    created.audits.push(audit.rows[0].id);
    const fakeStore = store();
    const first = await runRetention(options(true), fakeStore);
    expect(first.inbound.applied).toBe(1);
    expect(fakeStore.delete).toHaveBeenCalledWith("retention/attachment");
    expect(fakeStore.delete).toHaveBeenCalledWith("retention/mime");
    expect((await query("SELECT id FROM inbound_attachments WHERE id=$1 AND content_purged_at IS NOT NULL", [id])).rowCount).toBe(1);
    expect((await query<{ actor: string; action: string; details: unknown }>("SELECT actor,action,details FROM audit_logs WHERE id=$1", [audit.rows[0].id])).rows[0]).toEqual({ actor: "admin", action: "update", details: {} });
    expect((await runRetention(options(true), fakeStore)).inbound.applied).toBe(0);
    expect(fakeStore.delete).toHaveBeenCalledTimes(2);
  });
});

const objectKeys: string[] = [];
const orphanRawIds: string[] = [];
const objectKey = () => { const key = `object-cleanup/${crypto.randomUUID()}`; objectKeys.push(key); return key; };
const pass = (apply: boolean, storage: ObjectStore) => runRetention({ apply, batchSize: 100, days: {} }, storage);
const due = (key: string) => query("UPDATE pending_object_deletions SET available_at=now()-interval '1 minute' WHERE object_key=$1", [key]);

afterEach(async () => {
  for (const id of orphanRawIds.splice(0)) await query("DELETE FROM raw_provider_events WHERE id=$1", [id]);
  if (objectKeys.length) await query("DELETE FROM pending_object_deletions WHERE object_key=ANY($1::text[])", [objectKeys.splice(0)]);
});

describe("object-store / database handoff cleanup", () => {
  it("preserves live upload intents, previews expired orphan deletion, and applies it idempotently", async () => {
    const live = objectKey(); const orphan = objectKey();
    await registerObjectUpload(live); await registerObjectUpload(orphan); await due(orphan);
    const storage = store();
    expect((await pass(false, storage)).objectDeletions.eligible).toBe(1);
    expect(storage.delete).not.toHaveBeenCalled();
    expect((await pass(true, storage)).objectDeletions.applied).toBe(1);
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith(orphan);
    expect((await query("SELECT object_key FROM pending_object_deletions WHERE object_key=$1", [live])).rowCount).toBe(1);
    expect((await pass(true, storage)).objectDeletions.applied).toBe(0);
  });

  it("checks both raw-body and external verification receipt references before deleting", async () => {
    const body = objectKey(); const receipt = objectKey();
    for (const key of [body, receipt]) { await registerObjectUpload(key); await due(key); }
    const id = createId("cleanupraw"); orphanRawIds.push(id);
    await query(`INSERT INTO raw_provider_events(id,provider_account_id,webhook_endpoint_id,native_type,signature_valid,replay_valid,headers,raw_object_key,verification)
      VALUES ($1,'pa_mock','pwe_mock','delivered',true,true,'{}',$2,$3)`, [id, body, { objectKey: receipt }]);
    const storage = store();
    expect((await pass(true, storage)).objectDeletions.applied).toBe(2);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("keeps deletion failures durable and retries them after bounded backoff", async () => {
    const key = objectKey(); await registerObjectUpload(key); await due(key);
    const storage = store(); vi.mocked(storage.delete).mockRejectedValueOnce(new Error("store unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await pass(true, storage)).objectDeletions.failed).toBe(1);
      const failure = (await query<{ attempt_count: number; last_error: string; delayed: boolean }>("SELECT attempt_count,last_error,available_at>now() AS delayed FROM pending_object_deletions WHERE object_key=$1", [key])).rows[0];
      expect(failure).toEqual({ attempt_count: 1, last_error: "store unavailable", delayed: true });
      await due(key);
      expect((await pass(true, storage)).objectDeletions.applied).toBe(1);
      expect(storage.delete).toHaveBeenCalledTimes(2);
    } finally { log.mockRestore(); }
  });

  it("commits removal of an upload intent in the referencing business transaction", async () => {
    const key = objectKey(); await registerObjectUpload(key);
    await expect(transaction(async client => {
      await completeObjectUploads(client, [key]);
      throw new Error("reference transaction failed");
    })).rejects.toThrow("reference transaction failed");
    expect((await query("SELECT object_key FROM pending_object_deletions WHERE object_key=$1", [key])).rowCount).toBe(1);
    await transaction(client => completeObjectUploads(client, [key]));
    expect((await query("SELECT object_key FROM pending_object_deletions WHERE object_key=$1", [key])).rowCount).toBe(0);
  });

  it("fences references from an upload whose expired intent has already been reclaimed", async () => {
    const key = objectKey();
    await registerObjectUpload(key); await due(key);
    await pass(true, store());
    await expect(transaction(client => completeObjectUploads(client, [key]))).rejects.toThrow("claim expired");
  });
});
