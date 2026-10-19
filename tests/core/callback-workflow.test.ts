import { describe, expect, it, vi } from "vitest";
import { createCallbackService } from "@/modules/callbacks/application/service";
import type { CallbackDependencies, CallbackRepository } from "@/modules/callbacks/application/ports";
import type { CallbackClaim } from "@/modules/callbacks/contracts";

const claim: CallbackClaim = {
  id: "delivery", endpointId: "endpoint", url: "https://callback.example.test/receive", eligible: true,
  payload: { id: "event" }, attempt: 1, secretCiphertext: "cipher", encryptedDek: "dek", keyVersion: "test",
};
function fixture(methods: Partial<CallbackRepository>) {
  const repository = new Proxy(methods as CallbackRepository, { get(target, key) {
    if (!(key in target)) throw new Error(`Unexpected repository operation: ${String(key)}`);
    return Reflect.get(target, key);
  } });
  const sent = vi.fn().mockResolvedValue({ status: 204, statusText: "No Content", body: "" });
  const dependencies: CallbackDependencies = {
    repository, unitOfWork: { run: work => work(repository) }, id: prefix => `${prefix}-id`, now: () => new Date(1_800_000_000_000),
    secrets: { sign: () => "signature", generate: () => "new-secret", seal: () => claim },
    transport: { validate: async url => url, send: async (_url, _body, _headers, beforeSend) => { await beforeSend(); return sent(); } },
  };
  return { service: createCallbackService(dependencies), sent };
}
describe("callback application boundaries without a database", () => {
  it("stops before HTTP when receiving permissions change during DNS resolution", async () => {
    const recordFailure = vi.fn().mockResolvedValue(new Date()), enqueue = vi.fn();
    const { service, sent } = fixture({ claim: async () => claim,
      currentDispatch: async () => ({ eligible: false, url: claim.url, secretCiphertext: claim.secretCiphertext }), recordFailure, enqueue });
    await service.deliverCallback(claim.id);
    expect(sent).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledWith(claim.id, 1, expect.objectContaining({ dead: true, message: "CALLBACK_BINDING_OR_SUBSCRIPTION_INVALID" }));
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("does not dispatch a duplicate job while another worker owns the delivery", async () => {
    const recoverPausedClaim = vi.fn();
    const { service, sent } = fixture({ claim: async () => null, recoverPausedClaim });
    await service.deliverCallback(claim.id);
    expect(recoverPausedClaim).toHaveBeenCalledWith(claim.id);
    expect(sent).not.toHaveBeenCalled();
  });
  it("does not enqueue a retry after a completed write loses its response", async () => {
    let completed = false;
    const enqueue = vi.fn();
    const { service, sent } = fixture({
      claim: async () => completed ? null : claim, recoverPausedClaim: async () => {},
      currentDispatch: async () => ({ eligible: true, url: claim.url, secretCiphertext: claim.secretCiphertext }),
      markDelivered: async () => { completed = true; throw new Error("Database response lost after commit"); },
      recordFailure: async () => null, enqueue,
    });
    await service.deliverCallback(claim.id);
    await service.deliverCallback(claim.id);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
