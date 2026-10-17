import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { runMigrations, Worker, createPostgresBackend, type PostgresQueueBackend } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, query } from "@/server/database";
import { closeQueues, createQueueWorker, DELIVERY_QUEUE, queues } from "@/server/queues";
import { dispatchOutboxBatch, markOutboxJobFailed } from "@/server/services/outbox";
import { retryOutbox } from "@/modules/admin/actions";
import { recoverWorkBatch } from "@/server/services/recovery";

const databaseName = `envoy_queue_${crypto.randomUUID().replaceAll("-", "")}`;
let previousUrl: string | undefined;
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? "postgresql://envoy:envoy@localhost:5432/postgres";

beforeAll(async () => {
  previousUrl = process.env.DATABASE_URL;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE "${databaseName}"`); } finally { await admin.end(); }
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = url.toString();
  const client = await db().connect();
  try {
    await client.query(await readFile("db/migrations/001_initial.sql", "utf8"));
    await runMigrations(client, "bullmq");
    await client.query(`INSERT INTO products(id,name) VALUES ('p','queue-test');
      INSERT INTO services(id,product_id,name) VALUES ('s','p','queue-test');
      INSERT INTO sending_domains(id,domain) VALUES ('domain','queue.test');
      INSERT INTO provider_accounts(id,type,name,public_config) VALUES ('provider','mock','queue-test','{}');
      INSERT INTO provider_webhook_endpoints(id,provider_account_id,opaque_token) VALUES ('webhook','provider','queue-test');
      INSERT INTO provider_identities(id,sending_domain_id,provider_account_id,status) VALUES ('identity','domain','provider','verified');
      INSERT INTO sender_profiles(id,product_id,sending_domain_id,name,from_name,from_local_part) VALUES ('sender','p','domain','queue-test','Queue','test');
      INSERT INTO messages(id,product_id,service_id,sending_domain_id,sender_snapshot,idempotency_key,payload_hash,recipient_count,subject,text_body,message_category)
      VALUES ('m','p','s','domain','{}','queue-test','test',1,'Queue','test','transactional');`);
  } finally { client.release(); }
}, 30_000);

afterAll(async () => {
  await closeQueues();
  await db().end();
  process.env.DATABASE_URL = previousUrl;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); } finally { await admin.end(); }
});

describe("PostgreSQL queue / transactional outbox handoff", () => {
  it("retries transient jobs with backoff on PostgreSQL", async () => {
    let attempts = 0;
    const worker = createQueueWorker(DELIVERY_QUEUE, async job => {
      if (job.name === "retry-test" && ++attempts < 3) throw new Error("transient");
    }, 1);
    worker.on("error", () => {});
    const run = worker.run();
    try {
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("retry job timed out")), 10_000);
        worker.on("completed", job => { if (job.name === "retry-test") { clearTimeout(timer); resolve(); } });
      });
      await queues().delivery.add("retry-test", {}, { jobId: "retry-test", attempts: 3, backoff: { type: "exponential", delay: 20 } });
      await done;
      expect(attempts).toBe(3);
      expect((await queues().delivery.getJob("retry-test"))?.attemptsMade).toBe(3);
      await queues().delivery.remove("retry-test");
    } finally { await worker.close(); await run; }
  }, 15_000);

  it("discovers persisted work after its LISTEN connection is terminated", async () => {
    const worker = createQueueWorker(DELIVERY_QUEUE, async () => {}, 1);
    worker.on("error", () => {});
    const run = worker.run();
    try {
      await worker.waitUntilReady();
      const terminated = await query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname=current_database() AND application_name='envoy-delivery' AND pid<>pg_backend_pid()`);
      expect(terminated.rowCount).toBeGreaterThan(0);
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("listener recovery timed out")), 10_000);
        worker.on("completed", job => { if (job.id === "listener-recovery") { clearTimeout(timer); resolve(); } });
      });
      await queues().delivery.add("listener-recovery", {}, { jobId: "listener-recovery" });
      await done;
      await queues().delivery.remove("listener-recovery");
    } finally { await worker.close(); await run; }
  }, 15_000);

  it("recovers a locked job after the executing worker process is killed", async () => {
    const child = fork("-e", [
      `const {Worker,createPostgresBackend}=require('bullmq');
       const worker=new Worker('envoy-delivery',async job=>{
         if(job.name==='kill-test'){process.send('active');await new Promise(()=>{});}
       },{connection:{connectionString:process.env.DATABASE_URL,schema:'bullmq',max:1},lockDuration:300,lockRenewTime:100,stalledInterval:200},createPostgresBackend);
       worker.on('error',()=>{});worker.waitUntilReady().then(()=>process.send('ready'));`,
    ], { cwd: process.cwd(), env: { ...process.env }, silent: true, execArgv: [] });
    const nextMessage = (expected: string) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child worker did not report ${expected}`)), 10_000);
      const listener = (message: unknown) => { if (message === expected) { clearTimeout(timer); child.off("message", listener); resolve(); } };
      child.on("message", listener);
    });
    let survivor: Worker<Record<string, string>, unknown, string, PostgresQueueBackend> | undefined;
    let run: Promise<void> | undefined;
    try {
      await nextMessage("ready");
      const active = nextMessage("active");
      await queues().delivery.add("kill-test", {}, { jobId: "kill-test" });
      await active;
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
      survivor = new Worker<Record<string, string>, unknown, string, PostgresQueueBackend>(DELIVERY_QUEUE, async () => {}, {
        connection: { connectionString: process.env.DATABASE_URL, schema: "bullmq", max: 1 },
        autorun: false, lockDuration: 300, lockRenewTime: 100, stalledInterval: 200,
      }, createPostgresBackend);
      survivor.on("error", () => {});
      const completed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("stalled job did not recover")), 10_000);
        survivor!.on("completed", job => { if (job.id === "kill-test") { clearTimeout(timer); resolve(); } });
      });
      run = survivor.run();
      await completed;
      expect(await (await queues().delivery.getJob("kill-test"))!.getState()).toBe("completed");
      await queues().delivery.remove("kill-test");
    } finally {
      child.kill("SIGKILL");
      if (survivor) await survivor.close();
      await run;
    }
  }, 15_000);

  it("deduplicates the add-success / published-update crash gap", async () => {
    await query(`INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload)
      VALUES ('crash-gap','submission','not-a-real-delivery','submission.requested','{"submissionId":"not-a-real-delivery"}')`);
    await queues().delivery.add("submission.requested", { submissionId: "not-a-real-delivery" }, { jobId: "crash-gap" });
    expect(await dispatchOutboxBatch()).toBe(1);
    expect(await queues().delivery.getJobCountByTypes("wait", "active", "completed")).toBe(1);
    const outbox = await query<{ status: string }>("SELECT status FROM outbox_events WHERE id='crash-gap'");
    expect(outbox.rows[0].status).toBe("published");
  });

  it("repairs missing published jobs from business state and does not duplicate future work", async () => {
    await query(`INSERT INTO deliveries(id,message_id,recipient_email,recipient_role,updated_at) VALUES
      ('missing','m','missing@queue.test','to',now()-interval '5 minutes'),
      ('future','m','future@queue.test','to',now()-interval '5 minutes'),
      ('accepted','m','accepted@queue.test','to',now()-interval '5 minutes');
      UPDATE deliveries SET lifecycle_status='accepted' WHERE id='accepted';
      INSERT INTO submissions(id,message_id,status,updated_at) VALUES ('missing','m','queued',now()-interval '5 minutes'),('future','m','queued',now()-interval '5 minutes'),('accepted','m','accepted',now()-interval '5 minutes');
      INSERT INTO submission_deliveries(submission_id,delivery_id) VALUES ('missing','missing'),('future','future'),('accepted','accepted');
      UPDATE deliveries SET current_submission_id=id WHERE id IN ('missing','future','accepted');
      INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,status,created_at,available_at,published_at) VALUES
      ('missing-job','submission','missing','submission.requested','{"submissionId":"missing"}','published',now()-interval '5 minutes',now()-interval '5 minutes',now()-interval '5 minutes'),
      ('future-job','submission','future','submission.requested','{"submissionId":"future"}','pending',now()-interval '5 minutes',now()+interval '1 hour',NULL)`);
    expect(await recoverWorkBatch()).toBe(1);
    expect(await recoverWorkBatch()).toBe(0);
    const rows = await query<{ aggregate_id: string; count: string }>("SELECT aggregate_id,count(*) FROM outbox_events WHERE aggregate_id IN ('missing','future','accepted') GROUP BY aggregate_id");
    expect(Object.fromEntries(rows.rows.map(row => [row.aggregate_id, Number(row.count)]))).toEqual({ missing: 2, future: 1 });
  });

  it("leaves exhausted work visible rather than generating an infinite recovery loop", async () => {
    await query(`INSERT INTO deliveries(id,message_id,recipient_email,recipient_role,updated_at) VALUES ('poison','m','poison@queue.test','to',now()-interval '5 minutes');
      INSERT INTO submissions(id,message_id,updated_at) VALUES ('poison','m',now()-interval '5 minutes');
      INSERT INTO submission_deliveries(submission_id,delivery_id) VALUES ('poison','poison');
      UPDATE deliveries SET current_submission_id='poison' WHERE id='poison';
      INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,status,created_at)
      VALUES ('poison-job','submission','poison','submission.requested','{"submissionId":"poison"}','failed',now()-interval '5 minutes')`);
    expect(await recoverWorkBatch()).toBe(0);
    const rows = await query<{ count: string }>("SELECT count(*) FROM outbox_events WHERE aggregate_id='poison'");
    expect(Number(rows.rows[0].count)).toBe(1);
  });
  it("retries a retained failed BullMQ job through the administrator's stable Outbox identity", async () => {
    const failing = createQueueWorker(DELIVERY_QUEUE, async job => { if (job.id === "poison-job") throw new Error("transient operator-fixed failure"); }, 1);
    failing.on("error", () => {});
    const failed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("failed job did not execute")), 10_000);
      failing.on("failed", job => { if (job?.id === "poison-job") { clearTimeout(timer); resolve(); } });
    });
    const running = failing.run();
    try {
      await queues().delivery.add("submission.requested", { submissionId: "poison" }, { jobId: "poison-job", attempts: 1 });
      await failed;
    } finally { await failing.close(); await running; }
    expect(await (await queues().delivery.getJob("poison-job"))!.getState()).toBe("failed");
    await retryOutbox("poison-job", "test-admin");
    expect(await queues().delivery.getJob("poison-job")).toBeUndefined();
    await dispatchOutboxBatch();
    expect(await (await queues().delivery.getJob("poison-job"))!.getState()).toBe("waiting");
    expect((await query("SELECT id FROM outbox_events WHERE id='poison-job' AND status='published'", [])).rowCount).toBe(1);
    expect((await query("SELECT id FROM audit_logs WHERE resource_id='poison-job' AND action='outbox.retry'")).rowCount).toBe(1);
    let executions = 0;
    const repaired = createQueueWorker(DELIVERY_QUEUE, async job => { if (job.id === "poison-job") executions++; }, 1);
    repaired.on("error", () => {});
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("repaired job did not execute")), 10_000);
      repaired.on("completed", job => { if (job.id === "poison-job") { clearTimeout(timer); resolve(); } });
    });
    const repairRun = repaired.run();
    try { await completed; expect(executions).toBe(1); }
    finally { await repaired.close(); await repairRun; }
    expect(await (await queues().delivery.getJob("poison-job"))!.getState()).toBe("completed");
  }, 15_000);

  it("records public queue failure diagnostics for both exhausted publication and worker processing", async () => {
    await query(`INSERT INTO deliveries(id,message_id,recipient_email,recipient_role) VALUES
      ('workflow-publish','m','publish@queue.test','to'),('workflow-worker','m','worker@queue.test','cc');
      INSERT INTO submissions(id,message_id) VALUES ('workflow-publish','m'),('workflow-worker','m');
      INSERT INTO submission_deliveries(submission_id,delivery_id) VALUES ('workflow-publish','workflow-publish'),('workflow-worker','workflow-worker');
      UPDATE deliveries SET current_submission_id=id WHERE id IN ('workflow-publish','workflow-worker');
      INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,status,attempt_count) VALUES
      ('workflow-publish-job','submission','workflow-publish','submission.requested','{"submissionId":"workflow-publish"}','pending',19),
      ('workflow-worker-job','submission','workflow-worker','submission.requested','{"submissionId":"workflow-worker"}','published',1)`);
    const queue = queues().delivery;
    const original = queue.add.bind(queue);
    const add = vi.spyOn(queue, "add").mockImplementation((name,data,options) => options?.jobId === "workflow-publish-job" ? Promise.reject(new Error("Queue dependency unavailable")) : original(name,data,options));
    const logging = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await dispatchOutboxBatch();
      await markOutboxJobFailed("workflow-worker-job", new Error("Worker dependency unavailable"));
    } finally { add.mockRestore(); logging.mockRestore(); }
    const rows = await query<{ id: string; lifecycle_status: string; last_error: { code: string; stage: string; retryDecision: { action: string } } }>("SELECT id,lifecycle_status,last_error FROM deliveries WHERE id IN ('workflow-publish','workflow-worker') ORDER BY id");
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) expect(row).toMatchObject({ lifecycle_status: "deferred", last_error: { code: "WORKFLOW_EXHAUSTED", stage: "queue", retryDecision: { action: "manual_review" } } });
    expect((await query("SELECT id FROM outbox_events WHERE id IN ('workflow-publish-job','workflow-worker-job') AND status='failed'")).rowCount).toBe(2);
    expect((await query("SELECT id FROM submission_events WHERE submission_id IN ('workflow-publish','workflow-worker') AND canonical_payload#>>'{metadata,diagnostic,code}'='WORKFLOW_EXHAUSTED'")).rowCount).toBe(2);
  });

  it("reopens a verified raw receipt for an orphaned scanning inbound message", async () => {
    await query(`INSERT INTO raw_provider_events(id,provider_account_id,webhook_endpoint_id,native_type,signature_valid,replay_valid,headers,verification,received_at,processed_at)
      VALUES ('orphan-raw','provider','webhook','inbound',true,true,'{}','{}',now()-interval '5 minutes',now()-interval '4 minutes');
      INSERT INTO inbound_messages(id,provider_account_id,raw_provider_event_id,from_email,to_emails,subject,status,processing_deadline_at,received_at)
      VALUES ('orphan-inbound','provider','orphan-raw','sender@queue.test','{recipient@queue.test}','Orphan','scanning',now()-interval '3 minutes',now()-interval '5 minutes')`);
    // A newly inserted earlier aggregate may require wrapping the bounded recovery cursor.
    await recoverWorkBatch();
    await recoverWorkBatch();
    expect((await query("SELECT id FROM raw_provider_events WHERE id='orphan-raw' AND processed_at IS NULL")).rowCount).toBe(1);
    expect((await query("SELECT id FROM outbox_events WHERE aggregate_id='orphan-raw' AND status='pending'")).rowCount).toBe(1);
  });

  it("closes exhausted final claims after a worker crashes before recording their result", async () => {
    await query(`INSERT INTO deliveries(id,message_id,recipient_email,recipient_role,lifecycle_status) VALUES ('exhausted','m','exhausted@queue.test','to','unknown');
      INSERT INTO submissions(id,message_id,status) VALUES ('exhausted','m','unknown');
      INSERT INTO submission_deliveries(submission_id,delivery_id) VALUES ('exhausted','exhausted');
      INSERT INTO submission_attempts(id,submission_id,attempt_number,provider_account_id,provider_identity_id,routing_snapshot,request_fingerprint,status,reconciliation_count,reconcile_after)
      VALUES ('exhausted-attempt','exhausted',1,'provider','identity','{}','fingerprint','reconciling',12,now()-interval '1 minute');
      UPDATE deliveries SET current_attempt_id='exhausted-attempt',current_submission_id='exhausted' WHERE id='exhausted';
      UPDATE submissions SET current_attempt_id='exhausted-attempt' WHERE id='exhausted';
      INSERT INTO raw_provider_events(id,provider_account_id,webhook_endpoint_id,native_type,signature_valid,replay_valid,headers,received_at,processing_attempt_count,next_attempt_at)
      VALUES ('exhausted-raw','provider','webhook','delivered',true,true,'{}',now()-interval '5 minutes',20,now()-interval '1 minute')`);
    await recoverWorkBatch();
    const attempt = (await query<{ status: string; reconcile_after: Date | null; error_code: string }>("SELECT status,reconcile_after,error_code FROM submission_attempts WHERE id='exhausted-attempt'")).rows[0];
    expect(attempt).toEqual({ status: "unknown", reconcile_after: null, error_code: "RECONCILIATION_EXHAUSTED" });
    expect((await query<{ processing_error: string }>("SELECT processing_error FROM raw_provider_events WHERE id='exhausted-raw'")).rows[0].processing_error).toContain("exhausted");
    expect((await query("SELECT id FROM outbox_events WHERE aggregate_id='exhausted-attempt'")).rowCount).toBe(0);
  });

});
