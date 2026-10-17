import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomain, refreshIdentity } from "@/modules/admin/actions";
import { loadProviderAccount } from "@/modules/config/provider-account";
import { resendModule } from "@/modules/providers/resend";
import { query } from "@/server/database";

vi.mock("@/modules/config/provider-account", () => ({ loadProviderAccount: vi.fn() }));

const records = [{ type: "TXT", name: "resend._domainkey", value: "dkim-public-key", status: "verified" }];
const domains: string[] = [];

beforeEach(() => {
  vi.mocked(loadProviderAccount).mockResolvedValue({
    module: resendModule,
    context: { accountId: "pa_mock", config: { type: "resend", schemaVersion: 1 }, secret: { type: "resend", apiKey: "test-key" } },
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of domains.splice(0)) await query("DELETE FROM sending_domains WHERE id=$1", [id]);
});

async function associate(domain: string) {
  const result = await createDomain({ domain, accountIds: ["pa_mock"] }, "test");
  domains.push(result.domainId);
  return result;
}

async function identity(domainId: string) {
  return (await query<{ id: string; external_identity_id: string | null; status: string; dns_records: unknown }>(
    "SELECT id,external_identity_id,status,dns_records FROM provider_identities WHERE sending_domain_id=$1", [domainId],
  )).rows[0];
}

describe("managed domain DNS persistence", () => {
  it("persists provider DNS records as a JSON array when associating a domain", async () => {
    vi.spyOn(resendModule.identity!, "createIdentity").mockResolvedValue({ externalIdentityId: "resend-domain", status: "verified", dnsRecords: records });
    const result = await associate("resend-created.example.com");
    expect(result.identities).toEqual([{ accountId: "pa_mock", status: "verified" }]);
    expect(await identity(result.domainId)).toMatchObject({ external_identity_id: "resend-domain", status: "verified", dns_records: records });
  });

  it("returns the actual provider error when domain association fails", async () => {
    vi.spyOn(resendModule.identity!, "createIdentity").mockRejectedValue(new Error("API key is restricted"));
    const result = await associate("resend-failed.example.com");
    expect(result.identities).toEqual([{ accountId: "pa_mock", status: "failed", error: "API key is restricted" }]);
    expect(await identity(result.domainId)).toMatchObject({ status: "failed", dns_records: [] });
  });

  it("recovers a failed association with no provider ID and preserves DNS records", async () => {
    const create = vi.spyOn(resendModule.identity!, "createIdentity").mockRejectedValueOnce(new Error("Temporary failure"));
    const result = await associate("resend-recovered.example.com");
    const failed = await identity(result.domainId);
    create.mockResolvedValue({ externalIdentityId: "recovered-domain", status: "verified", dnsRecords: records });
    await refreshIdentity(failed.id, "test");
    expect(await identity(result.domainId)).toMatchObject({ external_identity_id: "recovered-domain", status: "verified", dns_records: records });
  });

  it("refreshes an associated domain using its provider ID without creating it again", async () => {
    const create = vi.spyOn(resendModule.identity!, "createIdentity").mockResolvedValue({ externalIdentityId: "resend-domain", status: "pending", dnsRecords: [] });
    const result = await associate("resend-refreshed.example.com");
    const pending = await identity(result.domainId);
    const check = vi.spyOn(resendModule.identity!, "checkIdentity").mockResolvedValue({ status: "verified", dnsRecords: records });
    await refreshIdentity(pending.id, "test");
    expect(check).toHaveBeenCalledWith("resend-domain", expect.any(Object));
    expect(create).toHaveBeenCalledTimes(1);
    expect(await identity(result.domainId)).toMatchObject({ status: "verified", dns_records: records });
  });
});
