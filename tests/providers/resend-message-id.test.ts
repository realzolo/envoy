import { Webhook } from "svix";
import { describe, expect, it } from "vitest";
import { providerRegistry } from "@/integrations/providers/registry";
import { contentFreeOutboundEvents } from "@/integrations/providers/event-facts";
import type { ProviderSendContext } from "@/integrations/providers/contracts";

const adapter = providerRegistry("resend");
const context: ProviderSendContext = { accountId: "pa_rfc", config: { type: "resend", schemaVersion: 1 }, secret: { type: "resend", apiKey: "re_fixture" } };
const signingSecret = `whsec_${Buffer.from("rfc-webhook-fixture-key").toString("base64")}`;
async function receipt(messageId: unknown, nativeType = "email.sent") {
  const id = "svix-rfc-fixture", timestamp = new Date();
  const rawBody = Buffer.from(JSON.stringify({ type: nativeType, created_at: timestamp.toISOString(), data: {
    email_id: "opaque-provider-uuid", message_id: messageId, to: ["recipient@example.net"], subject: "private echo"
  } }));
  return adapter.webhook.verify({ rawBody, headers: { "svix-id": id, "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(signingSecret).sign(id, timestamp, rawBody) } }, context, { signingSecret });
}

describe("Resend actual outbound RFC Message-ID", () => {
  it.each(["email.sent", "email.delivered", "email.bounced"])("preserves the signed %s actual header through content-free replay facts", async nativeType => {
    const verified = await receipt("<Actual.Case-1@sender.example>", nativeType);
    expect(verified).toMatchObject({ valid: true, replaySafe: true });
    const events = await adapter.webhook.normalize(verified, context);
    expect(events[0]).toMatchObject({ externalMessageId: "opaque-provider-uuid", rfcMessageId: "<Actual.Case-1@sender.example>" });
    const facts = contentFreeOutboundEvents(events)!;
    expect(facts[0].rfcMessageId).toBe("<Actual.Case-1@sender.example>");
    expect(JSON.stringify(facts)).not.toContain("private echo");
  });

  it.each([undefined, null, "opaque-provider-uuid", "<no-at-sign>", "<one@example.net>\r\nX-Echo: private", "<one\u0000@example.net>", `<${"x".repeat(990)}@example.net>`])("never derives or confirms an invalid header %s", async value => {
    const events = await adapter.webhook.normalize(await receipt(value), context);
    expect(events[0].externalMessageId).toBe("opaque-provider-uuid");
    expect(events[0].rfcMessageId).toBeUndefined();
    expect(contentFreeOutboundEvents([{ ...events[0], rfcMessageId: typeof value === "string" ? value : undefined }])![0].rfcMessageId).toBeUndefined();
  });
});
