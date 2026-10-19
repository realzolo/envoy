import { describe, expect, it, vi } from "vitest";
import { createManagementService } from "@/modules/identity/application/management";
import type { ManagementRepository, ManagementUnitOfWork } from "@/modules/identity/application/ports";

vi.mock("@/modules/callbacks/public", () => ({ validateCallbackUrl: async (url: string) => url }));
vi.mock("@/platform/crypto/envelope", () => ({
  sealSecret: () => ({ secretCiphertext: "sealed", encryptedDek: "wrapped", keyVersion: "1" }),
}));

describe("Service creation credentials", () => {
  it("returns the first callback signing secret alongside the Service Key", async () => {
    const insertServiceCallback = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const empty = async () => ({ rows: [], rowCount: 0 });
    const repository = {
      insertService: empty,
      findRegisteredDomains: empty,
      findProviderIdentities: empty,
      deleteServiceBindings: empty,
      lockServiceCallback: empty,
      insertServiceCallback,
      insertServiceCredential: empty,
      recordCredentialIssue: empty,
      recordServiceCreation: empty,
    } as unknown as ManagementRepository;
    const unitOfWork: ManagementUnitOfWork = { run: async work => work(repository) };
    const service = createManagementService(repository, unitOfWork);

    const created = await service.createService({
      serviceName: "Notifications",
      domains: [],
      callbackUrl: "https://example.com/events",
    }, "admin@example.com");

    expect(created.key).toMatch(/^ev_live_/);
    expect(created.callback?.secret).toMatch(/^ev_cb_/);
    expect(insertServiceCallback).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: created.serviceId,
      url: "https://example.com/events",
    }));
  });
});
