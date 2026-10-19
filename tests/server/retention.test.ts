import { transactionContext } from "@/platform/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import { query, transaction } from "@/platform/database";
import { completeObjectUploads, registerObjectUpload } from "@/platform/storage/object-cleanup/public";
import { createId } from "@/platform/ids";
import { retentionOptions, runRetention } from "@/platform/retention/public";
import type { ObjectStore } from "@/platform/storage/object-store";

const created: { messages: string[]; files: string[]; raw: string[]; inbound: string[]; callbacks: string[]; audits: string[] } = { messages: [], files: [], raw: [], inbound: [], callbacks: [], audits: [] };
const store = (): ObjectStore => ({ put: vi.fn(), get: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) });
const options = (apply: boolean) => ({ apply, batchSize: 100, days: { messages: 3650, rawEvents: 3650, inbound: 3650, callbacks: 3650, auditDetails: 3650 } });

async function message(status: string) {
  const id = createId("retention");
  created.messages.push(id);
  await query(`INSERT INTO messages(id,service_id,sending_domain_id,sender_snapshot,idempotency_key,payload_hash,recipient_count,subject,text_body,message_category,accepted_at)
    VALUES ($1,'svc_atlas_auth','sd_atlas','{"fromEmail":"security@mail.atlas.test"}',$1,'original-fingerprint',1,'Private subject','Private body','security',now()-interval '4000 days')`, [id]);
  await query("INSERT INTO deliveries(id,message_id,recipient_email,recipient_role,lifecycle_status) VALUES ($1,$1,'retention@example.test','to',$2)", [id, status]);
  return id;
}

afterEach(async () => {
  for (const id of created.callbacks.splice(0)) await query("DELETE FROM callback_deliveries WHERE id=$1", [id]);
  for (const id of created.messages.splice(0)) await query("DELETE FROM messages WHERE id=$1", [id]);
  for (const id of created.files.splice(0)) await query("DELETE FROM outbound_files WHERE id=$1", [id]);
  for (const id of created.inbound.splice(0)) await query("DELETE FROM inbound_messages WHERE id=$1", [id]);
  for (const id of created.raw.splice(0)) await query("DELETE FROM raw_provider_events WHERE id=$1", [id]);
  for (const id of created.audits.splice(0)) await query("DELETE FROM audit_logs WHERE id=$1", [id]);
});

async function outboundFile() {
  const id = createId("retentionfile");
  created.files.push(id);
  await query(`INSERT INTO outbound_files(id,service_id,sending_domain_id,file_name,content_type,size_bytes,sha256,object_key,created_at)
    VALUES ($1,'svc_atlas_auth','sd_atlas','private.txt','text/plain',12,'retained-hash',$2,now()-interval '4000 days')`, [id, `retention/${id}`]);
  return { id, key: `retention/${id}` };
}

async function submission(messageId: string) {
  const id = createId("retentionsub");
  await query("INSERT INTO submissions(id,message_id,status) VALUES ($1,$2,'failed')", [id, messageId]);
  await query("INSERT INTO submission_deliveries(submission_id,delivery_id) VALUES ($1,$2)", [id, messageId]);
  return id;
}

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

  it("preserves correlation metadata and structured errors when deleting sensitive bodies", async () => {
    const id = await message("failed");
    const error = { code: "MAILBOX_NOT_FOUND", message: "Mailbox unavailable", stage: "recipient_delivery" };
    await query("UPDATE messages SET metadata=$2,provider_tags=$3 WHERE id=$1", [id, { orderId: "123" }, { purpose: "receipt" }]);
    await query("UPDATE deliveries SET last_error=$2 WHERE id=$1", [id, error]);
    await runRetention(options(true), store());
    expect((await query("SELECT metadata,provider_tags,subject,text_body FROM messages WHERE id=$1", [id])).rows[0]).toEqual({ metadata: { orderId: "123" }, provider_tags: { purpose: "receipt" }, subject: "", text_body: "" });
    expect((await query("SELECT last_error FROM deliveries WHERE id=$1", [id])).rows[0].last_error).toEqual(error);
  });

  it("keeps a shared attachment until every referencing message has expired", async () => {
    const file = await outboundFile();
    const done = await message("delivered");
    const unknown = await message("unknown");
    for (const id of [done, unknown]) await query("UPDATE messages SET attachment_snapshot=$2 WHERE id=$1", [id, JSON.stringify([{ fileId: file.id, objectKey: file.key, fileName: "private.txt" }])]);
    const storage = store();
    const first = await runRetention(options(true), storage);
    expect(first.messages.applied).toBe(1);
    expect(first.outboundFiles.applied).toBe(0);
    expect(storage.delete).not.toHaveBeenCalled();
    await query("UPDATE deliveries SET lifecycle_status='delivered' WHERE id=$1", [unknown]);
    const second = await runRetention(options(true), storage);
    expect(second.messages.applied).toBe(1);
    expect(second.outboundFiles.applied).toBe(1);
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith(file.key);
    expect((await query("SELECT sha256,file_name,content_purged_at FROM outbound_files WHERE id=$1", [file.id])).rows[0]).toMatchObject({ sha256: "retained-hash", file_name: "private.txt", content_purged_at: expect.any(Date) });
    expect((await query("SELECT attachment_snapshot FROM messages WHERE id=$1", [done])).rows[0].attachment_snapshot).toEqual([{ fileId: file.id, objectKey: file.key, fileName: "private.txt" }]);
  });

  it("retries expired outbound-file deletion without losing metadata or the purge reference", async () => {
    const file = await outboundFile();
    const storage = store();
    vi.mocked(storage.delete).mockRejectedValueOnce(new Error("storage unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await runRetention(options(false), storage)).outboundFiles.eligible).toBe(1);
      expect(storage.delete).not.toHaveBeenCalled();
      expect((await runRetention(options(true), storage)).outboundFiles.failed).toBe(1);
      expect((await query("SELECT object_key,content_purged_at FROM outbound_files WHERE id=$1", [file.id])).rows[0]).toEqual({ object_key: file.key, content_purged_at: null });
      expect((await runRetention(options(true), storage)).outboundFiles.applied).toBe(1);
      expect((await runRetention(options(true), storage)).outboundFiles.applied).toBe(0);
      expect(storage.delete).toHaveBeenCalledTimes(2);
    } finally { log.mockRestore(); }
  });

  it("protects unresolved submission attempts even when recipient projections are terminal", async () => {
    const id = await message("failed");
    const sid = await submission(id);
    await query(`INSERT INTO submission_attempts(id,submission_id,attempt_number,provider_account_id,provider_identity_id,routing_snapshot,request_fingerprint,status)
      VALUES ($1,$2,1,'pa_mock','pi_atlas_mock','{}','fingerprint','unknown')`, [createId("retentionattempt"), sid]);
    expect((await runRetention(options(true), store())).messages.applied).toBe(0);
  });

  it("retains current unresolved recipients even after another recipient authorized a retry", async () => {
    const id = await message("failed");
    const sid = await submission(id);
    const attemptId = createId("retentionattempt");
    await query(`INSERT INTO submission_attempts(id,submission_id,attempt_number,provider_account_id,provider_identity_id,routing_snapshot,request_fingerprint,status,retry_authorized_at,retry_authorized_by)
      VALUES ($1,$2,1,'pa_mock','pi_atlas_mock','{}','fingerprint','unknown',now(),'operator')`, [attemptId, sid]);
    await query("UPDATE deliveries SET current_attempt_id=$2,current_submission_id=$3,compliance_status='suppressed' WHERE id=$1", [id, attemptId, sid]);
    expect((await runRetention(options(true), store())).messages.applied).toBe(0);
    // Audit authorization records risk acceptance; uncertainty only stops being
    // relevant to retained content once no current recipient uses that attempt.
    await query("UPDATE deliveries SET current_attempt_id=NULL,current_submission_id=NULL WHERE id=$1", [id]);
    expect((await runRetention(options(true), store())).messages.applied).toBe(1);
    expect((await query("SELECT status,outcome_determinate FROM submission_attempts WHERE id=$1", [attemptId])).rows[0]).toEqual({ status: "unknown", outcome_determinate: false });
  });

  it("protects content and raw receipts while a submission callback still requires replay", async () => {
    const id = await message("failed");
    const sid = await submission(id);
    const rawId = createId("retentionraw"); created.raw.push(rawId);
    await query(`INSERT INTO raw_provider_events(id,provider_account_id,webhook_endpoint_id,native_type,signature_valid,replay_valid,raw_body,headers,received_at,processed_at)
      VALUES ($1,'pa_mock','pwe_mock','failed',true,true,$2,'{}',now()-interval '4000 days',now()-interval '4000 days')`, [rawId, Buffer.from("raw")]);
    const event = createId("retentionsev");
    await query("INSERT INTO submission_events(id,submission_id,raw_provider_event_id,event_type,source_key,occurred_at,canonical_payload) VALUES ($1,$2,$3,'failed',$1,now(),'{}')", [event, sid, rawId]);
    const callback = createId("retentioncb"); created.callbacks.push(callback);
    await query("INSERT INTO callback_deliveries(id,endpoint_id,submission_event_id,event_type,payload,status) VALUES ($1,'cb_atlas_local',$2,'email.failed','{}','dead_letter')", [callback, event]);
    const first = await runRetention(options(true), store());
    expect(first.messages.applied).toBe(0);
    expect(first.rawEvents.applied).toBe(0);
    await query("UPDATE callback_deliveries SET status='delivered',delivered_at=now() WHERE id=$1", [callback]);
    const second = await runRetention(options(true), store());
    expect(second.messages.applied).toBe(1);
    expect(second.rawEvents.applied).toBe(1);
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
    await query(`INSERT INTO inbound_messages(id,provider_account_id,from_email,to_emails,subject,text_body,raw_mime_object_key,status,received_at,created_at)
      VALUES ($1,'pa_mock','sender@example.test','{recipient@example.test}','Private inbound','Private body','retention/mime','ready',now()-interval '4000 days',now()-interval '4000 days')`, [id]);
    await query("INSERT INTO inbound_attachments(id,inbound_message_id,file_name,content_type,size_bytes,object_key,sha256) VALUES ($1,$1,'file.txt','text/plain',12,'retention/attachment','digest')", [id]);
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

  it("never treats retained outbound file bytes or active message snapshots as orphans", async () => {
    const file = await outboundFile();
    objectKeys.push(file.key);
    await registerObjectUpload(file.key); await due(file.key);
    const snapshotKey = objectKey();
    await registerObjectUpload(snapshotKey); await due(snapshotKey);
    const id = await message("unknown");
    await query("UPDATE messages SET attachment_snapshot=$2 WHERE id=$1", [id, JSON.stringify([{ fileId: "snapshot-only", objectKey: snapshotKey }])]);
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
      await completeObjectUploads(transactionContext(client), [key]);
      throw new Error("reference transaction failed");
    })).rejects.toThrow("reference transaction failed");
    expect((await query("SELECT object_key FROM pending_object_deletions WHERE object_key=$1", [key])).rowCount).toBe(1);
    await transaction(client => completeObjectUploads(transactionContext(client), [key]));
    expect((await query("SELECT object_key FROM pending_object_deletions WHERE object_key=$1", [key])).rowCount).toBe(0);
  });

  it("fences references from an upload whose expired intent has already been reclaimed", async () => {
    const key = objectKey();
    await registerObjectUpload(key); await due(key);
    await pass(true, store());
    await expect(transaction(client => completeObjectUploads(transactionContext(client), [key]))).rejects.toThrow("claim expired");
  });
});
