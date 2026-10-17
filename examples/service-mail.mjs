// Node.js 22+. Business connection: Envoy URL, service key, mailbox and callback signing secret.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
export async function api(path, { body, idempotencyKey } = {}) {
  const response = await fetch(`${required("ENVOY_URL").replace(/\/$/, "")}/api/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${required("ENVOY_SERVICE_KEY")}`, ...(body ? { "content-type": "application/json", "idempotency-key": idempotencyKey } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.detail), { code: result.code, requestId: result.requestId });
  return result;
}
export function verifyCallback(headers, body, secret) {
  const timestamp = headers["x-envoy-timestamp"];
  const signature = headers["x-envoy-signature"];
  if (typeof timestamp !== "string" || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || typeof signature !== "string" || !/^v1=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex"));
}

export async function receiveEvents(port = 6180) {
  const secret = required("ENVOY_CALLBACK_SECRET");
  // Mount persistent storage here; a successful callback means only durable receipt.
  const inbox = resolve(process.env.BUSINESS_EVENT_INBOX ?? "var/example-business-inbox");
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/events") { response.writeHead(404).end(); return; }
    let temporary;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1_000_000) { response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (!verifyCallback(request.headers, body, secret)) { response.writeHead(401).end(); return; }
      const event = JSON.parse(body.toString("utf8"));
      if (typeof event.id !== "string" || request.headers["x-envoy-id"] !== event.id) { response.writeHead(400).end(); return; }
      const destination = resolve(inbox, `${createHash("sha256").update(event.id).digest("hex")}.json`);
      temporary = `${destination}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
      // Atomic insert-if-absent deduplicates retries and concurrent receipts by stable event ID.
      try { await link(temporary, destination); } catch (error) { if (error.code !== "EEXIST") throw error; }
      const directory = await open(inbox, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      response.writeHead(202).end();
    } catch { response.writeHead(503).end(); }
    finally { if (temporary) await unlink(temporary).catch(() => {}); }
  });
  server.listen(port, "127.0.0.1");
  console.log(`Callback receiver: http://127.0.0.1:${port}/events (publish via your HTTPS ingress)`);
  return server;
}

async function main() {
  const [command = "discover", argument, recipient] = process.argv.slice(2);
  if (command === "serve") { await receiveEvents(); return; }
  if (command === "discover") { console.log(JSON.stringify(await api("/capabilities"), null, 2)); return; }
  if (command === "inbound") { console.log(await api("/inbound-messages")); return; }
  if (command === "events") {
    const inbox = resolve(process.env.BUSINESS_EVENT_INBOX ?? "var/example-business-inbox");
    for (const name of (await readdir(inbox)).filter(name => name.endsWith(".json"))) {
      const event = JSON.parse(await readFile(resolve(inbox, name), "utf8"));
      console.log(event); // Replace with your own durable business handler; event.id is its deduplication key.
      if (event.type === "inbound.received") console.log(await api(`/inbound-messages/${encodeURIComponent(event.data.inboundMessageId)}`));
    }
    return;
  }
  if (command === "send" || command === "reply") {
    if (!argument || !recipient) throw new Error("Usage: send <stable-business-id> <recipient> | reply <inbound-id> <recipient>");
    const mailbox = required("ENVOY_MAILBOX");
    const previous = command === "reply" ? await api(`/inbound-messages/${encodeURIComponent(argument)}`) : null;
    const result = await api("/messages", { idempotencyKey: `${command}:${argument}`, body: {
      from: { email: mailbox, name: process.env.BUSINESS_MAIL_NAME ?? "Support" }, to: [{ email: recipient }], replyTo: [{ email: mailbox }],
      subject: previous ? `Re: ${previous.subject}` : "Hello", text: "Hello from your business service.",
      ...(previous?.messageId ? { inReplyTo: previous.messageId, references: [...previous.references, previous.messageId].slice(-50) } : {}),
    } });
    console.log(result); // 202 means queued; inspect status or consume signed delivery events.
    console.log(await api(`/messages/${encodeURIComponent(result.id)}`));
    return;
  }
  throw new Error("Commands: discover, send, inbound, reply, serve, events");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
