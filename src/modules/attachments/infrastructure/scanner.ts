import { digest } from "../domain/digest";
import { createConnection } from "node:net";
import { MAX_FILE_BYTES } from "@/lib/contracts";

export function scanPolicy() {
  const timeout = Number(process.env.CLAMAV_TIMEOUT_MS ?? 15000);
  const concurrency = Number(process.env.ATTACHMENT_SCAN_CONCURRENCY ?? 4);
  const baseVersion = process.env.ATTACHMENT_POLICY_VERSION?.trim() || "1";
  const mode = process.env.ATTACHMENT_SCAN_MODE?.trim() || "require_clean";
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16 || !/^[a-zA-Z0-9._-]{1,80}$/.test(baseVersion) || !["require_clean", "integrity_only"].includes(mode)) throw new Error("Invalid Envoy attachment safety configuration");
  const version = mode === "integrity_only" ? `integrity:${baseVersion}` : baseVersion;
  return { version, timeout, concurrency, configured: Boolean(process.env.CLAMAV_HOST?.trim()), mode: mode as "require_clean" | "integrity_only" };
}

type Verdict = { status: "clean" | "verified" | "malicious" | "unavailable"; reason: string | null; sha256: string };
let active = 0;

/** One bounded INSTREAM command. No engine response/signature/file name escapes this module. */
export async function scanBytes(bytes: Uint8Array): Promise<Verdict> {
  const sha256 = digest(bytes);
  const result = (status: Verdict["status"], reason: string | null): Verdict => ({ status, reason, sha256 });
  const policy = scanPolicy();
  if (bytes.byteLength > MAX_FILE_BYTES) return result("unavailable", "FILE_SIZE_EXCEEDED");
  if (policy.mode === "integrity_only") return result("verified", null);
  if (!policy.configured) return result("unavailable", "SCAN_NOT_CONFIGURED");
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return result("unavailable", "SCAN_CONFIGURATION_INVALID");
  if (active >= policy.concurrency) return result("unavailable", "SCAN_CAPACITY_BUSY");
  active++;
  return new Promise(resolve => {
    let done = false;
    const socket = createConnection({ host: process.env.CLAMAV_HOST!.trim(), port });
    const chunks: Buffer[] = [];
    let length = 0;
    let streamWritten = false;
    const finish = (status: Verdict["status"], reason: string | null) => {
      if (done) return;
      done = true; clearTimeout(timer); active--; socket.destroy(); resolve(result(status, reason));
    };
    // Wall-clock deadline includes connect, writes/backpressure, and the entire response.
    const timer = setTimeout(() => finish("unavailable", "SCAN_TIMEOUT"), policy.timeout);
    socket.on("error", () => finish("unavailable", "SCAN_CONNECTION_FAILED"));
    socket.on("close", () => finish("unavailable", "SCAN_CONNECTION_CLOSED"));
    socket.on("data", chunk => {
      length += chunk.length;
      if (length > 4096) { finish("unavailable", "SCAN_PROTOCOL_INVALID"); return; }
      chunks.push(chunk);
    });
    socket.on("end", () => {
      const raw = Buffer.concat(chunks), response = raw.toString("utf8");
      if (!streamWritten || !Buffer.from(response,"utf8").equals(raw)) {finish("unavailable","SCAN_PROTOCOL_INVALID");return;}
      if (response === "stream: OK\0") finish("clean", null);
      else if (/^stream: [^\x00\r\n]{1,1024} FOUND\x00$/.test(response)) finish("malicious", "FILE_MALICIOUS");
      else finish("unavailable", "SCAN_PROTOCOL_INVALID");
    });
    socket.on("connect", () => {
      // Await each write callback: at most one chunk is buffered, including when the peer stops reading.
      const write = (data: Uint8Array) => new Promise<void>((yes, no) => socket.write(data, error => error ? no(error) : yes()));
      void (async () => {
        await write(Buffer.from("zINSTREAM\0"));
        for (let offset = 0; offset < bytes.byteLength; offset += 8192) {
          if (done) return;
          const chunk = bytes.subarray(offset, offset + 8192), size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.byteLength); await write(size); await write(chunk);
        }
        if (!done) {await write(Buffer.alloc(4));streamWritten=true;}
      })().catch(() => finish("unavailable", "SCAN_CONNECTION_FAILED"));
    });
  });
}
