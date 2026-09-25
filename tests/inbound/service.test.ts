import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createId: vi.fn(),
  objectStore: vi.fn(),
  put: vi.fn(),
  query: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/modules/config/object-store", () => ({
  objectStore: mocks.objectStore
}));
vi.mock("@/server/database", () => ({
  query: mocks.query,
  transaction: mocks.transaction
}));
vi.mock("@/server/ids", () => ({
  createId: mocks.createId
}));

import { persistInbound, scanAttachment } from "@/modules/inbound/service";

const route = {
  id: "ir_test",
  product_id: "prd_test",
  service_id: null,
  callback_endpoint_id: null
};

const message = {
  externalMessageId: "external-test",
  from: "sender@example.test",
  to: ["support@example.test"],
  cc: [],
  bcc: [],
  subject: "Inbound test",
  rawMime: new Uint8Array([1, 2, 3]),
  attachments: [],
  receivedAt: new Date("2026-09-24T00:00:00.000Z")
};

function configureTransactions() {
  let count = 0;
  mocks.transaction.mockImplementation(async (callback: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
    const transactionNumber = count++;
    const client = {
      query: vi.fn().mockResolvedValue(transactionNumber < 2 ? { rows: [route], rowCount: 1 } : { rows: [], rowCount: 1 })
    };
    return callback(client);
  });
}

describe("inbound attachment scanning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createId.mockImplementation((prefix: string) => `${prefix}_test`);
    mocks.objectStore.mockReturnValue({ put: mocks.put });
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "", "   "])("skips scanning in production when CLAMAV_HOST is %s", async host => {
    vi.stubEnv("NODE_ENV", "production");
    if (host === undefined) delete process.env.CLAMAV_HOST;
    else vi.stubEnv("CLAMAV_HOST", host);

    await expect(scanAttachment(new Uint8Array([1, 2, 3]))).resolves.toBe("skipped");
  });

  it("fails closed when ClamAV does not return a scan result", async () => {
    const server = createServer(socket => {
      let received = Buffer.alloc(0);
      socket.on("data", chunk => {
        received = Buffer.concat([received, chunk]);
        if (received.subarray(-4).equals(Buffer.alloc(4))) socket.end("stream: ERROR\\0");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no TCP port");
    vi.stubEnv("CLAMAV_HOST", "127.0.0.1");
    vi.stubEnv("CLAMAV_PORT", String(address.port));
    try {
      await expect(scanAttachment(new Uint8Array([1, 2, 3]))).rejects.toThrow("ClamAV scan did not return a valid result");
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("keeps a scanning message retryable after an object-store failure", async () => {
    configureTransactions();
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "inb_test", status: "scanning" }], rowCount: 1 });
    mocks.put.mockRejectedValueOnce(new Error("S3 temporarily unavailable")).mockResolvedValueOnce(undefined);

    await expect(persistInbound({
      providerAccountId: "pa_test",
      webhookEndpointId: "pwe_test",
      rawEventId: "raw_test",
      message
    })).rejects.toThrow("S3 temporarily unavailable");
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("status='rejected'"))).toBe(false);

    await expect(persistInbound({
      providerAccountId: "pa_test",
      webhookEndpointId: "pwe_test",
      rawEventId: "raw_test",
      message
    })).resolves.toBe("inb_test");
    expect(mocks.put).toHaveBeenCalledTimes(2);
  });

  it("rejects message-size violations without retrying the processing failure", async () => {
    configureTransactions();
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(persistInbound({
      providerAccountId: "pa_test",
      webhookEndpointId: "pwe_test",
      rawEventId: "raw_test",
      message: { ...message, rawMime: { byteLength: 25 * 1024 * 1024 + 1 } as Uint8Array }
    })).resolves.toBe("inb_test");
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("status='rejected'"))).toBe(true);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("rejects a scanning message when its route is no longer eligible", async () => {
    mocks.transaction.mockImplementation(async (callback: (client: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) => callback({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    }));
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: "inb_test", status: "scanning" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(persistInbound({
      providerAccountId: "pa_test",
      webhookEndpointId: "pwe_test",
      rawEventId: "raw_test",
      message
    })).resolves.toBe("inb_test");
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("status='rejected'"))).toBe(true);
    expect(mocks.put).not.toHaveBeenCalled();
  });
});
