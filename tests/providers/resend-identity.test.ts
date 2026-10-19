import { afterEach, describe, expect, it, vi } from "vitest";
import { resendIdentityStatus, resendModule } from "@/integrations/providers/resend";
import type { ProviderSendContext } from "@/integrations/providers/contracts";

const context: ProviderSendContext = {
  accountId: "pa_resend",
  config: { type: "resend", schemaVersion: 1 },
  secret: { type: "resend", apiKey: "test-resend-key" },
};
afterEach(() => vi.unstubAllGlobals());

describe("Resend identity status mapping", () => {
  it("keeps incomplete Resend domain states ineligible for routing", () => {
    expect(resendIdentityStatus("verified")).toBe("verified");
    expect(resendIdentityStatus("failed")).toBe("failed");
    expect(resendIdentityStatus("not_started")).toBe("pending");
    expect(resendIdentityStatus("partially_verified")).toBe("pending");
    expect(resendIdentityStatus("partially_failed")).toBe("pending");
  });
});

describe("Resend domain association", () => {
  it("reuses an existing domain on a later page and retrieves its current verification and DNS records", async () => {
    const records = [{ type: "TXT", name: "resend._domainkey", value: "dkim", status: "verified" }];
    const transport = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "first", name: "other.example" }], has_more: true }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "existing", name: "Mail.Example.com", status: "pending" }], has_more: false }))
      .mockResolvedValueOnce(Response.json({ id: "existing", status: "verified", records }));
    vi.stubGlobal("fetch", transport);

    await expect(resendModule.identity!.createIdentity("mail.example.com", context)).resolves.toEqual({
      externalIdentityId: "existing", status: "verified", dnsRecords: records,
    });
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.resend.com/domains?limit=100",
      "https://api.resend.com/domains?limit=100&after=first",
      "https://api.resend.com/domains/existing",
    ]);
    expect(transport.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
  });

  it("does not treat a previously verified domain as verified when its current state is incomplete", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "existing", name: "mail.example.com", status: "verified" }], has_more: false }))
      .mockResolvedValueOnce(Response.json({ id: "existing", status: "partially_verified", records: [] }));
    vi.stubGlobal("fetch", transport);
    await expect(resendModule.identity!.createIdentity("mail.example.com", context)).resolves.toMatchObject({ status: "pending" });
  });

  it("creates a new domain only after the account's domains have been exhausted", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [], has_more: false }))
      .mockResolvedValueOnce(Response.json({ id: "created", status: "not_started", records: [] }));
    vi.stubGlobal("fetch", transport);
    await expect(resendModule.identity!.createIdentity("mail.example.com", context)).resolves.toEqual({
      externalIdentityId: "created", status: "pending", dnsRecords: [],
    });
    expect(transport.mock.calls[1][1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(transport.mock.calls[1][1].body)).toMatchObject({ name: "mail.example.com", region: "us-east-1" });
  });

  it("preserves lookup errors instead of trying to create a domain after an unsuccessful lookup", async () => {
    const transport = vi.fn().mockResolvedValue(Response.json({ name: "restricted_api_key", message: "API key is restricted", statusCode: 403 }, { status: 403 }));
    vi.stubGlobal("fetch", transport);
    await expect(resendModule.identity!.createIdentity("mail.example.com", context)).rejects.toThrow("API key is restricted");
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
