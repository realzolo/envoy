vi.mock("@/server/admin-auth", () => ({ getAdminSession: vi.fn().mockResolvedValue({ email: "admin@example.test" }) }));
import { describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import { configureProviderWebhook, createProviderAccount } from "@/modules/channels/public";
import { adminData } from "@/server/admin-queries";
import { ingestProviderWebhook } from "@/modules/inbound/public";
import { query } from "@/platform/database";

describe("provider webhook configuration and observed verification", () => {
  it("shows a valid event only after actual verification with the current settings, without returning secrets", async () => {
    const provider = await createProviderAccount({ type: "resend", name: `Webhook status ${crypto.randomUUID()}`, configuration: {}, credentials: { apiKey: "re_local_test_key" } }, "test");
    const account = async () => (await adminData("providers")).providers!.find(item => item.id === provider.accountId)!;
    const endpoint = await account();
    const secret = `whsec_${Buffer.from("envoy-local-webhook-status-secret").toString("base64")}`;
    const request = () => {
      const id = crypto.randomUUID(), timestamp = new Date();
      const raw = JSON.stringify({ type: "email.delivered", created_at: timestamp.toISOString(), data: { email_id: crypto.randomUUID(), to: ["recipient@example.test"] } });
      return { rawBody: Buffer.from(raw), headers: { "svix-id": id, "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)), "svix-signature": new Webhook(secret).sign(id, timestamp, raw) } };
    };
    try {
      expect(endpoint).toMatchObject({ security_configured: false, last_event_at: null });
      expect((await ingestProviderWebhook("resend", String(endpoint.opaque_token), request())).status).toBe(401);
      await configureProviderWebhook(String(endpoint.webhook_endpoint_id), { signingSecret: secret }, "test");
      const configured = await account();
      expect(configured).toMatchObject({ security_configured: true, last_event_at: null });
      expect(JSON.stringify(configured)).not.toContain(secret);
      expect((await ingestProviderWebhook("resend", String(endpoint.opaque_token), request())).status).toBe(202);
      expect((await account()).last_event_at).toBeInstanceOf(Date);
      await configureProviderWebhook(String(endpoint.webhook_endpoint_id), { signingSecret: secret }, "test");
      expect((await account()).last_event_at).toBeNull();
      const invalid = request();
      invalid.headers["svix-signature"] = "invalid";
      expect((await ingestProviderWebhook("resend", String(endpoint.opaque_token), invalid)).status).toBe(401);
      expect((await account()).last_event_at).toBeNull();
    } finally {
      await query("DELETE FROM outbox_events WHERE payload->>'rawEventId' IN (SELECT id FROM raw_provider_events WHERE provider_account_id=$1)", [provider.accountId]);
      await query("DELETE FROM raw_provider_events WHERE provider_account_id=$1", [provider.accountId]);
      await query("DELETE FROM provider_accounts WHERE id=$1", [provider.accountId]);
    }
  });
});
