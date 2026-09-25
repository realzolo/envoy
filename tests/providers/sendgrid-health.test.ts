import { afterEach, describe, expect, it, vi } from "vitest";
import { providerRegistry } from "@/modules/providers/registry";
import type { ProviderSendContext } from "@/modules/providers/contracts";

const context: ProviderSendContext = {
  accountId: "pa_sendgrid",
  config: { type: "sendgrid", schemaVersion: 1, region: "global" },
  secret: { type: "sendgrid", apiKey: "SG.test-key" }
};

afterEach(() => vi.unstubAllGlobals());

describe("SendGrid connection test", () => {
  it("uses the Mail Send permission without delivering a probe message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [] }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(providerRegistry("sendgrid").health.check(context)).resolves.toMatchObject({ healthy: true, details: { status: 400 } });
    expect(fetchMock).toHaveBeenCalledWith("https://api.sendgrid.com/v3/mail/send", expect.objectContaining({ method: "POST", body: "{}" }));
  });

  it("rejects a key without the required Mail Send permission", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    await expect(providerRegistry("sendgrid").health.check(context)).resolves.toMatchObject({ healthy: false, details: { status: 403 } });
  });
});
