import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SendDeadlineError } from "@/modules/core/message/policy";

const fixture = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: fixture.request }));
import { boundedProviderRequest, runWithSubmissionPolicy } from "@/modules/providers/submission-policy";

function transport() {
  const socket = new EventEmitter();
  const request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  request.destroy.mockImplementation((error: Error) => { request.emit("error", error); return request; });
  fixture.request.mockImplementation((_url, _options, response) => {
    request.end.mockImplementation(() => {
      const incoming = Object.assign(new PassThrough(), { statusCode: 200, statusMessage: "OK", headers: {} });
      request.emit("response", incoming); response(incoming); incoming.end("{}");
    });
    queueMicrotask(() => request.emit("socket", socket));
    return request;
  });
  return { socket, request };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); fixture.request.mockReset(); });
const options = { method: "POST", headers: { "content-type": "application/json" }, body: "sensitive payload" };

describe("deadline at the actual provider HTTP write boundary", () => {
  it("writes no headers/body while DNS/TLS is pending, and rechecks authorization after TLS", async () => {
    const connection = transport(); const guard = vi.fn().mockResolvedValue(undefined);
    const result = runWithSubmissionPolicy({ sendBefore: new Date(Date.now()+10_000), sensitive: true, beforeSend: guard }, () => boundedProviderRequest(new URL("https://provider.example/send"), options));
    await Promise.resolve();
    expect(connection.request.end).not.toHaveBeenCalled(); expect(guard).not.toHaveBeenCalled();
    connection.socket.emit("secureConnect"); const response = await result; response.resume();
    expect(guard).toHaveBeenCalledOnce(); expect(connection.request.end).toHaveBeenCalledWith("sensitive payload");
  });
  it("blocks an expired message after DNS/TLS without an HTTP write", async () => {
    const connection = transport(); let now = Date.now(); const deadline = new Date(now+10_000);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const result = runWithSubmissionPolicy({ sendBefore: deadline, sensitive: true, beforeSend: async () => {} }, () => boundedProviderRequest(new URL("https://provider.example/send"), options));
    await Promise.resolve(); now += 10_001; connection.socket.emit("secureConnect");
    await expect(result).rejects.toBeInstanceOf(SendDeadlineError);
    expect(connection.request.end).not.toHaveBeenCalled();
  });
  it("blocks revocation or a deadline crossed during the asynchronous final guard", async () => {
    const connection = transport(); let now = Date.now(); const deadline = new Date(now+10_000);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const result = runWithSubmissionPolicy({ sendBefore: deadline, sensitive: true, beforeSend: async () => { now += 10_001; } }, () => boundedProviderRequest(new URL("https://provider.example/send"), options));
    await Promise.resolve(); connection.socket.emit("secureConnect");
    await expect(result).rejects.toBeInstanceOf(SendDeadlineError); expect(connection.request.end).not.toHaveBeenCalled();
  });
  it("does not misclassify the ordinary connection timeout as message expiry", async () => {
    vi.useFakeTimers(); const connection = transport();
    const result = runWithSubmissionPolicy({ sendBefore: new Date(Date.now()+60_000), sensitive: true, beforeSend: async () => {} }, () => boundedProviderRequest(new URL("https://provider.example/send"), options));
    const rejected = expect(result).rejects.toMatchObject({ code: "PROVIDER_CONNECTION_UNAVAILABLE", outcome: "not_accepted", retryable: true });
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
    expect(connection.request.end).not.toHaveBeenCalled();
  });
  it("records final-guard rejection as definite nonacceptance while writing no HTTP data", async () => {
    const connection = transport();
    const result = runWithSubmissionPolicy({ sendBefore: new Date(Date.now()+10_000), sensitive: true, beforeSend: async () => { throw new Error("Domain grant revoked"); } }, () => boundedProviderRequest(new URL("https://provider.example/send"), options));
    await Promise.resolve(); connection.socket.emit("secureConnect");
    await expect(result).rejects.toMatchObject({ code: "SUBMISSION_GUARD_REJECTED", outcome: "not_accepted", retryable: false });
    expect(connection.request.end).not.toHaveBeenCalled();
  });

});
