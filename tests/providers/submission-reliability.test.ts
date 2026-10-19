import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { providerRegistry } from "@/integrations/providers/registry";
import type { CanonicalMessage, ProviderSendContext, ProviderType } from "@/integrations/providers/contracts";

const message: CanonicalMessage = { submissionId: "sub", from: { name: "App", email: "app@example.com" }, to: [{ email: "person@example.net" }], cc: [], bcc: [], replyTo: [], headers: {}, references: [], subject: "Hello", html: "<p>Hello</p>", text: "Hello", attachments: [], tags: {} };
const contexts: Partial<Record<ProviderType, ProviderSendContext>> = {
  resend: { accountId: "pa", config: { type: "resend", schemaVersion: 1 }, secret: { type: "resend", apiKey: "re_test_key" }, idempotencyKey: "attempt-stable-key" },
  sendgrid: { accountId: "pa", config: { type: "sendgrid", schemaVersion: 1, region: "global" }, secret: { type: "sendgrid", apiKey: "SG.test_key" } },
  mailgun: { accountId: "pa", config: { type: "mailgun", schemaVersion: 1, region: "us", sendingDomain: "mg.example.com" }, secret: { type: "mailgun", apiKey: "test-key" } },
  postmark: { accountId: "pa", config: { type: "postmark", schemaVersion: 1, messageStream: "outbound" }, secret: { type: "postmark", serverToken: "test-key" } },
};
afterEach(() => vi.unstubAllGlobals());
describe("submission transport boundary", () => {
  it.each(["resend", "sendgrid", "mailgun", "postmark"] as const)("keeps %s response loss unknown and performs one bounded call", async type => {
    const transport = vi.fn().mockRejectedValue(new TypeError("Connection reset after upload"));
    vi.stubGlobal("fetch", transport);
    await expect(providerRegistry(type).sender.send(message, contexts[type]!)).rejects.toMatchObject({ outcome: "unknown", category: "network", retryable: false });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it.each(["resend", "sendgrid", "mailgun", "postmark"] as const)("does not treat an ambiguous %s HTTP 500 as evidence for cross-provider resend", async type => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: "Internal error after processing" }, { status: 500 })));
    await expect(providerRegistry(type).sender.send(message, contexts[type]!)).rejects.toMatchObject({ outcome: "unknown", retryable: false });
  });
  it("keeps an SES server error unknown and disables its hidden retry budget", async () => {
    const client = mockClient(SESv2Client);
    client.on(SendEmailCommand).rejects(Object.assign(new Error("Internal failure"), { $metadata: { httpStatusCode: 500 } }));
    try {
      await expect(providerRegistry("ses").sender.send(message, { accountId: "pa", config: { type: "ses", schemaVersion: 1, region: "us-east-1" }, secret: { type: "ses" } })).rejects.toMatchObject({ outcome: "unknown", retryable: false });
      expect(client.commandCalls(SendEmailCommand)).toHaveLength(1);
    } finally { client.restore(); }
  });
  it("reuses the native idempotency key on another attempt to obtain the same result", async () => {
    const transport = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ id: "native-message-id" })));
    vi.stubGlobal("fetch", transport);
    for (let n = 0; n < 2; n++) await providerRegistry("resend").sender.send(message, contexts.resend!);
    expect(transport.mock.calls.map(call => call[1].headers["idempotency-key"])).toEqual(["attempt-stable-key", "attempt-stable-key"]);
  });
});
