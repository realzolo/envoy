import { Webhook } from "svix";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSendContext } from "@/integrations/providers/contracts";
import { providerRegistry } from "@/integrations/providers/registry";

const adapter = providerRegistry("resend");
const context = {
  accountId: "pa_resend",
  config: { type: "resend", schemaVersion: 1 },
  secret: { type: "resend", apiKey: "re_test_key" }
} satisfies ProviderSendContext;
const signingSecret = `whsec_${Buffer.from("resend-inbound-test-key").toString("base64")}`;
const emailId = "9a6f5e62-f5c0-4692-ae81-286091e874d4";

function receivedData(overrides: Record<string, unknown> = {}) {
  return {
    email_id: emailId,
    created_at: "2026-10-19T10:00:00.000Z",
    from: "Sender <sender@example.net>",
    to: ["support@example.test"],
    cc: ["billing@example.test"],
    bcc: ["private@example.test"],
    received_for: ["support@example.test", "billing@example.test"],
    message_id: "<rfc-message@example.net>",
    subject: "Received by Resend",
    attachments: [],
    ...overrides
  };
}

async function signedReceipt(data = receivedData(), eventId = "svix-inbound-1") {
  const body = Buffer.from(JSON.stringify({ type: "email.received", created_at: "2026-10-19T10:00:01.000Z", data }));
  const timestamp = new Date();
  const headers = {
    "svix-id": eventId,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(signingSecret).sign(eventId, timestamp, body)
  };
  return adapter.webhook.verify({ rawBody: body, headers }, context, { signingSecret });
}

afterEach(() => vi.unstubAllGlobals());

describe("Resend inbound", () => {
  it("turns a signed email.received event into an inbound fact and freezes the received_for recipients", async () => {
    const verified = await signedReceipt();
    expect(verified).toMatchObject({ valid: true, replaySafe: true, providerEventId: "svix-inbound-1" });
    expect(await adapter.webhook.normalize(verified, context)).toEqual([
      expect.objectContaining({ type: "inbound.received", externalMessageId: emailId, inboundReference: emailId })
    ]);
    expect(adapter.inbound!.routingReceipt(verified)).toEqual({
      externalMessageId: emailId,
      envelopeRecipients: ["support@example.test", "billing@example.test"]
    });
  });

  it("uses signed to/cc/bcc when received_for is missing and keeps the email ID stable across webhook retries", async () => {
    const data = receivedData({ received_for: undefined });
    const first = await signedReceipt(data, "svix-attempt-1");
    const retried = await signedReceipt(data, "svix-attempt-2");
    expect(first.providerEventId).not.toBe(retried.providerEventId);
    expect(adapter.inbound!.routingReceipt(first)).toEqual(adapter.inbound!.routingReceipt(retried));
    expect(adapter.inbound!.routingReceipt(first)).toEqual({
      externalMessageId: emailId,
      envelopeRecipients: ["support@example.test", "billing@example.test", "private@example.test"]
    });
  });

  it("fetches the received body and attachment through Resend without expanding frozen recipients", async () => {
    const verified = await signedReceipt(receivedData({
      received_for: ["support@example.test"],
      attachments: [{ id: "att_logo", filename: "logo.png", content_type: "image/png", content_disposition: "inline", content_id: "logo" }]
    }));
    const content = new Uint8Array([137, 80, 78, 71, 0, 1]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === `/emails/receiving/${emailId}`) {
        return Response.json({
          object: "email", id: emailId,
          from: "Sender <sender@example.net>", to: ["support@example.test", "other@example.net"],
          cc: ["billing@example.test"], bcc: [], reply_to: ["reply@example.net"],
          received_for: ["support@example.test"],
          subject: "Received by Resend", html: '<img src="cid:logo">', text: "Hello",
          message_id: "<rfc-message@example.net>", created_at: "2026-10-19T10:00:00.000Z",
          headers: { "In-Reply-To": "<parent@example.net>", References: "<root@example.net> <parent@example.net>" },
          attachments: [{ id: "att_logo", filename: "logo.png", size: content.byteLength, content_type: "image/png", content_disposition: "inline", content_id: "logo" }]
        });
      }
      if (url.pathname === `/emails/receiving/${emailId}/attachments/att_logo`) {
        return Response.json({
          object: "attachment", id: "att_logo", filename: "logo.png", size: content.byteLength,
          content_type: "image/png", content_disposition: "inline", content_id: "logo",
          download_url: "https://inbound-cdn.resend.com/files/att_logo", expires_at: "2026-10-20T10:00:00.000Z"
        });
      }
      if (url.href === "https://inbound-cdn.resend.com/files/att_logo") {
        return new Response(content, { headers: { "content-type": "image/png" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const message = await adapter.inbound!.receive(verified, context);
    expect(message).toMatchObject({
      externalMessageId: emailId,
      envelopeRecipients: ["support@example.test"],
      from: "Sender <sender@example.net>",
      to: ["support@example.test", "other@example.net"],
      cc: ["billing@example.test"],
      subject: "Received by Resend", html: '<img src="cid:logo">', text: "Hello",
      messageId: "<rfc-message@example.net>", replyTo: ["reply@example.net"],
      inReplyTo: "<parent@example.net>", references: ["<root@example.net>", "<parent@example.net>"]
    });
    expect(message?.attachments).toMatchObject([{ fileName: "logo.png", contentType: "image/png", contentId: "logo" }]);
    expect(Array.from(message?.attachments[0].content ?? [])).toEqual(Array.from(content));
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(`https://api.resend.com/emails/receiving/${emailId}?html_format=cid`);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
