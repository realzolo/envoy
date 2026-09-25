import { describe, expect, it } from "vitest";
import { postmarkWebhookUrl } from "@/components/provider-accounts";

describe("Postmark callback URL", () => {
  it("encodes Basic Auth credentials into the provider-facing URL", () => {
    expect(postmarkWebhookUrl(
      "/api/provider-events/postmark/opaque-token",
      "envoy@example.test",
      "secret: with spaces",
      "https://envoy.example"
    )).toBe("https://envoy%40example.test:secret%3A%20with%20spaces@envoy.example/api/provider-events/postmark/opaque-token");
  });
});
