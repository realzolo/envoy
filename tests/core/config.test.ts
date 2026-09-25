import { describe, expect, it } from "vitest";
import { providerConfigSchema, providerSecretSchema, providerWebhookSettingsSchema } from "@/modules/providers/contracts";
import { openSecret, sealSecret } from "@/modules/config/envelope";
import { objectStorageKey } from "@/modules/config/object-store";

describe("provider configuration", () => {
  it("fails closed on an unknown schema version", () => {
    expect(providerConfigSchema.safeParse({
      type: "resend",
      schemaVersion: 2,
      apiBase: "https://api.resend.com"
    }).success).toBe(false)
  });
  it("fails closed when credential type does not match a supported shape", () => {
    expect(providerSecretSchema.safeParse({ type: "sendgrid", apiKey: "" }).success).toBe(false)
  });
  it("does not allow provider API endpoints to be overridden", () => {
    expect(providerConfigSchema.safeParse({
      type: "resend",
      schemaVersion: 1,
      apiBase: "https://example.test"
    }).success).toBe(false)
  });
  it("validates webhook settings for the selected provider", () => {
    expect(providerWebhookSettingsSchema.safeParse({ type: "resend", signingSecret: "whsec_test_key" }).success).toBe(true);
    expect(providerWebhookSettingsSchema.safeParse({
      type: "sendgrid",
      eventWebhookPublicKey: "event-public-key-that-is-long-enough"
    }).success).toBe(true);
    expect(providerWebhookSettingsSchema.safeParse({
      type: "sendgrid",
      publicKey: "legacy-public-key-that-is-long-enough"
    }).success).toBe(false);
    expect(providerWebhookSettingsSchema.safeParse({ type: "resend", publicKey: "not-a-resend-secret" }).success).toBe(false)
  });
  it("uses resource and version as envelope AAD", () => {
    const envelope = sealSecret({ type: "mock", token: "secret" }, "account-a", 1);
    expect(openSecret(envelope, "account-a", 1)).toEqual({ type: "mock", token: "secret" });
    expect(() => openSecret(envelope, "account-b", 1)).toThrow()
  });
  it("fails closed when an envelope references an unavailable KEK version", () => {
    const envelope = sealSecret({ token: "secret" }, "account-a", 1);
    expect(() => openSecret({
      ...envelope,
      keyVersion: "missing-version"
    }, "account-a", 1)).toThrow(/No KEK is configured/)
  });
  it("scopes every object key under the configured prefix", () => {
    expect(objectStorageKey("inbound/message/attachments/file", "")).toBe("envoy/inbound/message/attachments/file");
    expect(objectStorageKey("/provider-events/resend/event.bin", "/custom/")).toBe("custom/provider-events/resend/event.bin");
    expect(() => objectStorageKey("../outside", "envoy")).toThrow(/Invalid object key/)
  })
});
