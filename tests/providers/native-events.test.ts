import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { providerRegistry } from "@/integrations/providers/registry";
import type { ProviderSendContext } from "@/integrations/providers/contracts";
const contexts = {
  sendgrid: { accountId: "pa", config: { type: "sendgrid", schemaVersion: 1, region: "global" }, secret: { type: "sendgrid", apiKey: "test-key" } },
  ses: { accountId: "pa", config: { type: "ses", schemaVersion: 1, region: "us-east-1" }, secret: { type: "ses" } },
  postmark: { accountId: "pa", config: { type: "postmark", schemaVersion: 1, messageStream: "outbound" }, secret: { type: "postmark", serverToken: "test-key" } },
  mailgun: { accountId: "pa", config: { type: "mailgun", schemaVersion: 1, region: "us", sendingDomain: "mg.example.com" }, secret: { type: "mailgun", apiKey: "test-key" } },
} satisfies Record<string, ProviderSendContext>;
const verified = (parsed: unknown) => ({ valid: true, replaySafe: true, nativeType: "event", parsed });
describe("native provider protocol facts", () => {
  it("accepts SendGrid's Base64 DER SPKI public key and refuses to parse unauthenticated payloads", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const rawBody = Buffer.from('[{"event":"delivered","timestamp":1700000000,"sg_event_id":"e"}]');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign("sha256", Buffer.concat([Buffer.from(timestamp), rawBody]), privateKey).toString("base64");
    const security = { eventWebhookPublicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
    const headers = { "x-twilio-email-event-webhook-timestamp": timestamp, "x-twilio-email-event-webhook-signature": signature };
    expect((await providerRegistry("sendgrid").webhook.verify({ rawBody, headers }, contexts.sendgrid, security)).valid).toBe(true);
    await expect(providerRegistry("sendgrid").webhook.verify({ rawBody: Buffer.from("malformed-json"), headers }, contexts.sendgrid, security)).resolves.toMatchObject({ valid: false, parsed: null });
  });
  it("deduplicates SendGrid receipts by the whole batch rather than its first event", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const security = { eventWebhookPublicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
    const verify = (events: string[]) => {
      const rawBody = Buffer.from(JSON.stringify(events.map(sg_event_id => ({ event: "delivered", timestamp: 1700000000, sg_event_id }))));
      const signature = sign("sha256", Buffer.concat([Buffer.from(timestamp), rawBody]), privateKey).toString("base64");
      return providerRegistry("sendgrid").webhook.verify({ rawBody, headers: { "x-twilio-email-event-webhook-timestamp": timestamp, "x-twilio-email-event-webhook-signature": signature } }, contexts.sendgrid, security);
    };
    const first = await verify(["event-a", "event-b"]);
    const expanded = await verify(["event-a", "event-b", "event-c"]);
    expect(first.valid && expanded.valid).toBe(true);
    expect(first.providerEventId).not.toBe(expanded.providerEventId);
    expect((await verify(["event-a", "event-b"])).providerEventId).toBe(first.providerEventId);
  });
  it("uses SES event time and enumerates bounced recipients with individual diagnostics", async () => {
    const events = await providerRegistry("ses").webhook.normalize(verified({ Type: "Notification", Message: JSON.stringify({ eventType: "Bounce", mail: { messageId: "m", timestamp: "2026-10-17T08:00:00Z", destination: ["a@example.net", "b@example.net"] }, bounce: { bounceType: "Permanent", timestamp: "2026-10-17T08:00:02Z", bouncedRecipients: [{ emailAddress: "a@example.net", status: "5.1.1" }, { emailAddress: "b@example.net", status: "5.2.1" }] } }) }), contexts.ses);
    expect(events.map(event => event.recipient)).toEqual(["a@example.net", "b@example.net"]);
    expect(events[0]).toMatchObject({ occurredAt: new Date("2026-10-17T08:00:02Z"), bounce: { classification: "hard", code: "5.1.1" } });
    expect(events[0].id).not.toBe(events[1].id);
  });
  it.each([["Open", "open", "opened"], ["Click", "click", "clicked"]])("keeps SES %s message scoped when a group member is unidentified", async (eventType, detailsKey, type) => {
    const events = await providerRegistry("ses").webhook.normalize(verified({ Type: "Notification", Message: JSON.stringify({ eventType, mail: { messageId: "m", timestamp: "2026-10-17T08:00:00Z", destination: ["a@example.net", "b@example.net"] }, [detailsKey]: { timestamp: "2026-10-17T08:00:02Z" } }) }), contexts.ses);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type, externalMessageId: "m" });
    expect(events[0].recipient).toBeUndefined();
  });
  it("only assigns Resend recipient scope when the webhook supplies exactly one recipient", async () => {
    const adapter = providerRegistry("resend");
    const context: ProviderSendContext = { accountId: "pa", config: { type: "resend", schemaVersion: 1 }, secret: { type: "resend", apiKey: "re_test_key" } };
    const payload = { type: "email.opened", created_at: "2026-10-17T08:00:00Z", data: { email_id: "m", to: ["a@example.net", "b@example.net"] } };
    expect((await adapter.webhook.normalize(verified(payload), context))[0].recipient).toBeUndefined();
    payload.data.to = ["a@example.net"];
    expect((await adapter.webhook.normalize(verified(payload), context))[0].recipient).toBe("a@example.net");
  });
  it("preserves Postmark HardBounce and Email facts with stable replay identity", async () => {
    const input = verified({ RecordType: "Bounce", ID: 1, MessageID: "m", Type: "HardBounce", TypeCode: 1, Email: "a@example.net", BouncedAt: "2026-10-17T08:00:02Z" });
    const adapter = providerRegistry("postmark");
    const events = await adapter.webhook.normalize(input, contexts.postmark);
    expect(events[0]).toMatchObject({ recipient: "a@example.net", bounce: { classification: "hard" }, occurredAt: new Date("2026-10-17T08:00:02Z") });
    expect(await adapter.webhook.normalize(input, contexts.postmark)).toEqual(events);
  });
  it.each([["permanent", "bounced", "hard"], ["temporary", "deferred", "soft"]])("maps Mailgun %s delivery failure", async (severity, type, classification) => {
    const events = await providerRegistry("mailgun").webhook.normalize(verified({ "event-data": { id: "e", event: "failed", severity, timestamp: 1700000000, recipient: "a@example.net", message: { headers: { "message-id": "m" } }, "delivery-status": { code: 550, message: "Mailbox unavailable" } } }), contexts.mailgun);
    expect(events[0]).toMatchObject({ id: "e", type, recipient: "a@example.net", bounce: { classification, code: "550" } });
  });
});

describe("Postmark native inbound JSON", () => {
  it("accepts the official payload without RecordType and retains attachments and address lists", async () => {
    const adapter = providerRegistry("postmark");
    const payload = { MessageStream: "inbound", MessageID: "inbound-message", From: "sender@example.net", OriginalRecipient: "inbound@example.com", ToFull: [{ Email: "inbound@example.com" }], CcFull: [{ Email: "cc@example.net" }], Date: "Sat, 17 Oct 2026 08:00:00 +0000", TextBody: "Hello", Attachments: [{ Name: "hello.txt", ContentType: "text/plain", Content: "aGVsbG8=" }] };
    const receipt = await adapter.webhook.verify({ rawBody: Buffer.from(JSON.stringify(payload)), headers: { authorization: `Basic ${Buffer.from("envoy:password").toString("base64")}` } }, contexts.postmark, { username: "envoy", password: "password" });
    expect(receipt.valid).toBe(true);
    expect(receipt.nativeType).toBe("Inbound");
    const inbound = await adapter.inbound!.receive(receipt, contexts.postmark);
    expect(inbound).toMatchObject({ externalMessageId: "inbound-message:inbound@example.com", cc: ["cc@example.net"], authorDate: new Date("2026-10-17T08:00:00Z") });
    expect(Buffer.from(inbound!.attachments[0].content).toString()).toBe("hello");
  });
});
