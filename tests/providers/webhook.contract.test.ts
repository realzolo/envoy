import { createHmac, createSign, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Webhook } from "svix";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerRegistry } from "@/modules/providers/registry";
import type { ProviderSendContext } from "@/modules/providers/contracts";
import {
  isTrustedSnsSigningCertificateUrl,
  isTrustedSnsSubscribeUrl,
  snsSignatureAlgorithm
} from "@/modules/providers/ses/sns-security";

const fixture = async (name: string) => readFile(resolve("tests/fixtures", name));
afterEach(() => vi.unstubAllGlobals());
describe("provider webhook security and normalization", () => {
  it("allows only the expected regional SNS certificate and confirmation URLs", () => {
    const topicArn = "arn:aws:sns:us-east-1:123456789012:envoy";
    const subscription = `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topicArn)}&Token=test-token`;

    expect(isTrustedSnsSigningCertificateUrl("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem", topicArn)).toBe(true);
    expect(isTrustedSnsSigningCertificateUrl("https://s3.us-east-1.amazonaws.com/SimpleNotificationService-test.pem", topicArn)).toBe(false);
    expect(isTrustedSnsSigningCertificateUrl("https://sns.us-west-2.amazonaws.com/SimpleNotificationService-test.pem", topicArn)).toBe(false);
    expect(isTrustedSnsSubscribeUrl(subscription, topicArn)).toBe(true);
    expect(isTrustedSnsSubscribeUrl(subscription.replace("ConfirmSubscription", "Subscribe"), topicArn)).toBe(false);
    expect(snsSignatureAlgorithm("1")).toBe("RSA-SHA1");
    expect(snsSignatureAlgorithm("2")).toBe("RSA-SHA256");
    expect(snsSignatureAlgorithm("3")).toBeNull();
  });

  it("verifies Resend Svix signatures and rejects stale replay timestamps", async () => {
    const raw = await fixture("resend-delivered.json");
    const key = Buffer.from("resend-webhook-test-key").toString("base64");
    const secret = `whsec_${key}`;
    const webhook = new Webhook(secret);
    const id = "msg_resend_fixture";
    const timestamp = new Date();
    const signature = webhook.sign(id, timestamp, raw);
    const context = {
      accountId: "pa",
      config: { type: "resend", schemaVersion: 1 },
      secret: { type: "resend", apiKey: "re_test_key" }
    } satisfies ProviderSendContext;
    const adapter = providerRegistry("resend");
    const verified = await adapter.webhook.verify({
      rawBody: raw,
      headers: {
        "svix-id": id,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "svix-signature": signature
      }
    }, context, { signingSecret: secret });
    expect(verified.valid).toBe(true);
    expect(verified.replaySafe).toBe(true);
    const events = await adapter.webhook.normalize(verified, context);
    expect(events[0]).toMatchObject({ type: "delivered", externalMessageId: "re_message_123" });
    const stale = new Date(Date.now() - 10 * 60_000);
    const staleVerified = await adapter.webhook.verify({
      rawBody: raw,
      headers: {
        "svix-id": id,
        "svix-timestamp": String(Math.floor(stale.getTime() / 1000)),
        "svix-signature": webhook.sign(id, stale, raw)
      }
    }, context, { signingSecret: secret });
    expect(staleVerified.replaySafe).toBe(false)
  });
  it("verifies SES SNS certificates and the expected TopicArn", async () => {
    const nested = JSON.parse((await fixture("ses-delivery.json")).toString("utf8"));
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const payload: Record<string, unknown> = {
      Type: "Notification",
      MessageId: "sns-event-123",
      TopicArn: "arn:aws:sns:us-east-1:123456789012:envoy",
      Subject: "SES event",
      Message: JSON.stringify(nested),
      Timestamp: new Date().toISOString(),
      SignatureVersion: "1",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem"
    };
    const canonical = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"].map(key => `${key}\n${String(payload[key])}\n`).join("");
    const signer = createSign("RSA-SHA1");
    signer.update(canonical);
    signer.end();
    payload.Signature = signer.sign(privateKey, "base64");
    const fetchMock = vi.fn().mockResolvedValue(new Response(publicKey.export({
      type: "spki",
      format: "pem"
    }).toString()));
    vi.stubGlobal("fetch", fetchMock);
    const context = {
      accountId: "pa",
      config: { type: "ses", schemaVersion: 1, region: "us-east-1" },
      secret: { type: "ses", accessKeyId: "AKIATEST", secretAccessKey: "test-secret" }
    } satisfies ProviderSendContext;
    const adapter = providerRegistry("ses");
    const verified = await adapter.webhook.verify({
      rawBody: new TextEncoder().encode(JSON.stringify(payload)),
      headers: {}
    }, context, { expectedTopicArn: payload.TopicArn });
    expect(verified.valid).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const events = await adapter.webhook.normalize(verified, context);
    expect(events[0]).toMatchObject({ type: "delivered", externalMessageId: "ses_message_123" });

    fetchMock.mockClear();
    const untrustedCertificate = { ...payload, SigningCertURL: "https://s3.us-east-1.amazonaws.com/certificate.pem" };
    const rejected = await adapter.webhook.verify({
      rawBody: new TextEncoder().encode(JSON.stringify(untrustedCertificate)),
      headers: {}
    }, context, { expectedTopicArn: payload.TopicArn });
    expect(rejected.valid).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("verifies SendGrid ECDSA signed event webhooks", async () => {
    const raw = await fixture("sendgrid-delivered.json");
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign("sha256", Buffer.concat([Buffer.from(timestamp), raw]), privateKey).toString("base64");
    const context = {
      accountId: "pa",
      config: { type: "sendgrid", schemaVersion: 1, region: "global" },
      secret: {
        type: "sendgrid",
        apiKey: "SG.test-key"
      }
    } satisfies ProviderSendContext;
    const adapter = providerRegistry("sendgrid");
    const verified = await adapter.webhook.verify({
      rawBody: raw,
      headers: {
        "x-twilio-email-event-webhook-timestamp": timestamp,
        "x-twilio-email-event-webhook-signature": signature
      }
    }, context, { eventWebhookPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString() });
    expect(verified.valid).toBe(true);
    expect((await adapter.webhook.normalize(verified, context))[0]).toMatchObject({
      type: "delivered",
      externalMessageId: "sg_message_123"
    })
  });
  it("uses the dedicated SendGrid Inbound Parse verification key", async () => {
    const raw = Buffer.from("--envoy-boundary\r\nContent-Disposition: form-data; name=\"from\"\r\n\r\nsender@example.test\r\n--envoy-boundary\r\nContent-Disposition: form-data; name=\"to\"\r\n\r\nmail@example.test\r\n--envoy-boundary--\r\n");
    const eventKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const inboundKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign("sha256", Buffer.concat([Buffer.from(timestamp), raw]), inboundKeys.privateKey).toString("base64");
    const context = {
      accountId: "pa",
      config: { type: "sendgrid", schemaVersion: 1, region: "global" },
      secret: { type: "sendgrid", apiKey: "SG.test-key" }
    } satisfies ProviderSendContext;
    const adapter = providerRegistry("sendgrid");
    const security = {
      eventWebhookPublicKey: eventKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      inboundParsePublicKey: inboundKeys.publicKey.export({ type: "spki", format: "pem" }).toString()
    };
    const request = {
      rawBody: raw,
      headers: {
        "content-type": "multipart/form-data; boundary=envoy-boundary",
        "x-twilio-email-event-webhook-timestamp": timestamp,
        "x-twilio-email-event-webhook-signature": signature
      }
    };

    expect((await adapter.webhook.verify(request, context, security)).valid).toBe(true);
    expect((await adapter.webhook.verify(request, context, {
      eventWebhookPublicKey: security.eventWebhookPublicKey
    })).valid).toBe(false);
  });
  it("verifies Mailgun timestamp and token HMAC", async () => {
    const payload = JSON.parse((await fixture("mailgun-delivered.json")).toString("utf8"));
    payload.signature.timestamp = String(Math.floor(Date.now() / 1000));
    payload.signature.signature = createHmac("sha256", "mailgun-signing-key").update(payload.signature.timestamp + payload.signature.token).digest("hex");
    const context = {
      accountId: "pa",
      config: { type: "mailgun", schemaVersion: 1, region: "us", sendingDomain: "mg.example.com" },
      secret: { type: "mailgun", apiKey: "key-mailgun-test" }
    } satisfies ProviderSendContext;
    const adapter = providerRegistry("mailgun");
    const verified = await adapter.webhook.verify({
      rawBody: new TextEncoder().encode(JSON.stringify(payload)),
      headers: { "content-type": "application/json" }
    }, context, { webhookSigningKey: "mailgun-signing-key" });
    expect(verified.valid).toBe(true);
    expect((await adapter.webhook.normalize(verified, context))[0]).toMatchObject({
      type: "delivered",
      externalMessageId: "mailgun-message-123"
    })
  });
  it("uses Postmark Basic Auth, opaque endpoint routing, IP allowlist, and schema validation", async () => {
    const raw = await fixture("postmark-delivered.json");
    const context = {
      accountId: "pa",
      config: { type: "postmark", schemaVersion: 1, messageStream: "outbound" },
      secret: {
        type: "postmark",
        serverToken: "server-token"
      }
    } satisfies ProviderSendContext;
    const adapter = providerRegistry("postmark");
    const verified = await adapter.webhook.verify({
      rawBody: raw,
      headers: { authorization: `Basic ${Buffer.from("envoy:secret-password").toString("base64")}` },
      remoteAddress: "203.0.113.10"
    }, context, { username: "envoy", password: "secret-password", ipAllowlist: ["203.0.113.10"] });
    expect(verified.valid).toBe(true);
    expect((await adapter.webhook.normalize(verified, context))[0]).toMatchObject({
      type: "delivered",
      externalMessageId: "postmark-message-123"
    });
    const rejected = await adapter.webhook.verify({
      rawBody: raw,
      headers: { authorization: "Basic invalid" },
      remoteAddress: "198.51.100.9"
    }, context, { username: "envoy", password: "secret-password", ipAllowlist: ["203.0.113.10"] });
    expect(rejected.valid).toBe(false)
  });
});
