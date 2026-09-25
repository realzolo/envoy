import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CallbackUrlPolicyError,
  isPrivateOrReservedAddress,
  postCallback,
  resolveCallbackTarget
} from "@/modules/callbacks/url-policy";

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

      expect(response).toMatchObject({ status: 202, body: "accepted" });
      expect(received).toBe('{"id":"event-test"}');
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
