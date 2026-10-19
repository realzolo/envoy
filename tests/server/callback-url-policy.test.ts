import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallbackUrlPolicyError } from "@/modules/callbacks/domain/policy";
import { isPrivateOrReservedAddress, postCallback, resolveCallbackTarget, sendCallback } from "@/modules/callbacks/infrastructure/http-transport";

afterEach(() => vi.unstubAllEnvs());

describe("callback URL policy", () => {
  it("rejects private, loopback, and reserved addresses by default", async () => {
    vi.stubEnv("ENVOY_ALLOW_PRIVATE_CALLBACKS", "");
    expect(isPrivateOrReservedAddress("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedAddress("169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedAddress("64:ff9b::a9fe:a9fe")).toBe(true);
    expect(isPrivateOrReservedAddress("10.0.0.5")).toBe(true);
    expect(isPrivateOrReservedAddress("::1")).toBe(true);
    await expect(resolveCallbackTarget("https://callbacks.example.test", async () => [{ address: "10.0.0.5", family: 4 }]))
      .rejects.toBeInstanceOf(CallbackUrlPolicyError);
  });

  it("requires HTTPS and rejects URL credentials", async () => {
    vi.stubEnv("ENVOY_ALLOW_PRIVATE_CALLBACKS", "");
    const publicAddress = async () => [{ address: "93.184.216.34", family: 4 as const }];
    await expect(resolveCallbackTarget("http://callbacks.example.test", publicAddress)).rejects.toBeInstanceOf(CallbackUrlPolicyError);
    await expect(resolveCallbackTarget("https://user:password@callbacks.example.test", publicAddress)).rejects.toBeInstanceOf(CallbackUrlPolicyError);
  });

  it("permits a public HTTPS callback and pins its resolved address", async () => {
    vi.stubEnv("ENVOY_ALLOW_PRIVATE_CALLBACKS", "");
    const target = await resolveCallbackTarget("https://callbacks.example.test/events", async () => [{
      address: "93.184.216.34",
      family: 4
    }]);

    expect(target.url.toString()).toBe("https://callbacks.example.test/events");
    expect(target.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("allows an internal HTTP callback only after explicit opt-in", async () => {
    vi.stubEnv("ENVOY_ALLOW_PRIVATE_CALLBACKS", "true");
    const target = await resolveCallbackTarget("http://callback.internal/events", async () => [{
      address: "172.18.0.10",
      family: 4
    }]);

    expect(target.url.protocol).toBe("http:");
  });

  it("uses the already validated address for callback delivery", async () => {
    vi.stubEnv("ENVOY_ALLOW_PRIVATE_CALLBACKS", "true");
    let received = "";
    const server = createServer((request, response) => {
      request.on("data", chunk => { received += chunk; });
      request.on("end", () => {
        response.statusCode = 202;
        response.end("accepted");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const port = (server.address() as AddressInfo).port;
      const target = await resolveCallbackTarget(`http://callback.internal:${port}/events`, async () => [{
        address: "127.0.0.1",
        family: 4
      }]);
      const response = await postCallback(target, '{"id":"event-test"}', { "content-type": "application/json" });

      expect(response).toMatchObject({ status: 202, body: "" });
      expect(received).toBe('{"id":"event-test"}');
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

describe("callback execution deadline", () => {
  async function listening(handler: RequestListener) {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/events` };
  }
  it("ends successful delivery at response headers even while a body keeps streaming", async () => {
    vi.stubEnv("ENVOY_ALLOW_PRIVATE_CALLBACKS", "true");
    let closed = false;
    const { server, url } = await listening((_request, response) => {
      response.writeHead(204); response.flushHeaders();
      response.on("close", () => { closed = true; });
    });
    try {
      expect(await sendCallback(url, "{}", {}, async () => {}, { timeoutMs: 200 })).toMatchObject({ status: 204, body: "" });
      await new Promise(resolve => setTimeout(resolve, 20)); expect(closed).toBe(true);
    } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
  });
  it("aborts a failure response that drips below its summary limit", async () => {
    vi.stubEnv("ENVOY_ALLOW_PRIVATE_CALLBACKS", "true");
    const { server, url } = await listening((_request, response) => {
      response.writeHead(503); response.flushHeaders();
      const interval = setInterval(() => response.write("a"), 5);
      response.on("close", () => clearInterval(interval));
    });
    try { await expect(sendCallback(url, "{}", {}, async () => {}, { timeoutMs: 50 })).rejects.toThrow("deadline exceeded"); }
    finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
  });
  it("bounds and releases a failure body without waiting for the peer to finish", async () => {
    vi.stubEnv("ENVOY_ALLOW_PRIVATE_CALLBACKS", "true");
    const { server, url } = await listening((_request, response) => { response.writeHead(500); response.write("a".repeat(2000)); });
    try {
      const result = await sendCallback(url, "{}", {}, async () => {}, { timeoutMs: 200 });
      expect(result.status).toBe(500); expect(Buffer.byteLength(result.body)).toBe(500);
    } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
  });
  it("does not connect or authorize after DNS resolves beyond the deadline", async () => {
    vi.stubEnv("ENVOY_ALLOW_PRIVATE_CALLBACKS", "true");
    const before = vi.fn(async () => {}), received = vi.fn();
    const { server, url } = await listening((_request, response) => { received(); response.end(); });
    let release!: (value: { address: string; family: 4 }[]) => void;
    const resolved = new Promise<{ address: string; family: 4 }[]>(resolve => { release = resolve; });
    try {
      await expect(sendCallback(url.replace("127.0.0.1", "callback.test"), "{}", {}, before, { timeoutMs: 30, resolver: () => resolved })).rejects.toThrow("deadline exceeded");
      release([{ address: "127.0.0.1", family: 4 }]);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(before).not.toHaveBeenCalled(); expect(received).not.toHaveBeenCalled();
    } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
  });
  it("never writes after a final authorization wait outlives the deadline", async () => {
    vi.stubEnv("ENVOY_ALLOW_PRIVATE_CALLBACKS", "true");
    const received = vi.fn();
    const { server, url } = await listening((_request, response) => { received(); response.end(); });
    let release!: () => void;
    const authorization = new Promise<void>(resolve => { release = resolve; });
    try {
      await expect(sendCallback(url, "{}", {}, () => authorization, { timeoutMs: 30 })).rejects.toThrow("deadline exceeded");
      release(); await new Promise(resolve => setTimeout(resolve, 20)); expect(received).not.toHaveBeenCalled();
    } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
  });
  it("rejects an interrupted response before acknowledging failure details", async () => {
    vi.stubEnv("ENVOY_ALLOW_PRIVATE_CALLBACKS", "true");
    const { server, url } = await listening((_request, response) => {
      response.writeHead(503, { "content-length": "50" }); response.write("short");
      setTimeout(() => response.destroy(), 5);
    });
    try { await expect(sendCallback(url, "{}", {}, async () => {}, { timeoutMs: 200 })).rejects.toThrow(); }
    finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
  });
});

it("includes TLS handshake waits in the callback execution deadline", async () => {
  vi.stubEnv("ENVOY_ALLOW_PRIVATE_CALLBACKS", "true");
  const sockets = new Set<import("node:net").Socket>();
  const server = createTcpServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const before = vi.fn(async () => {});
  try {
    await expect(sendCallback(`https://127.0.0.1:${(server.address() as AddressInfo).port}/events`, "{}", {}, before, { timeoutMs: 50 })).rejects.toThrow("deadline exceeded");
    expect(before).not.toHaveBeenCalled();
  } finally { for (const socket of sockets) socket.destroy(); server.close(); await once(server, "close"); }
});
