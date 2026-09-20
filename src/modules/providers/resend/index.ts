import { Resend } from "resend";
import { Webhook } from "svix";
import { type CanonicalEventType, CanonicalProviderError, type ProviderModule } from "../contracts";
import { accepted, event, header } from "../shared";

function client(secret: { type: string; apiKey?: string }) {
  if (secret.type !== "resend" || !secret.apiKey) throw new Error("Invalid Resend credential");
  return new Resend(secret.apiKey);
}

const eventMap: Record<string, CanonicalEventType> = {
  "email.sent": "accepted", "email.delivered": "delivered", "email.delivery_delayed": "deferred",
  "email.bounced": "bounced", "email.failed": "failed", "email.opened": "opened",
  "email.clicked": "clicked", "email.complained": "complained", "email.suppressed": "suppressed",
  "email.received": "inbound.received",
};

export const resendModule: ProviderModule = {
  descriptor: {
    type: "resend",
    displayName: "Resend",
    capabilities: {
      nativeIdempotency: true,
      inboundMode: "webhook-fetch",
      domainManagement: true,
      webhookSecurity: "Svix HMAC",
      eventTypes: Object.keys(eventMap),
      attachments: true,
      scheduling: true
    }
  },
  sender: {
    async send(message, context) {
      if (context.config.type !== "resend") throw new Error("Invalid Resend configuration");
      const result = await client(context.secret).emails.send({
        from: `${message.from.name} <${message.from.email}>`,
        to: message.to.name ? `${message.to.name} <${message.to.email}>` : message.to.email,
        replyTo: message.replyTo,
        subject: message.subject,
        html: message.html,
        text: message.text,
        tags: Object.entries(message.tags).map(([name, value]) => ({ name, value }))
      }, { idempotencyKey: context.idempotencyKey });
      if (result.error) {
        const name = String(result.error.name ?? "provider_error");
        const detail = result.error.message.toLowerCase();
        const category = name.includes("rate_limit") ? "rate_limit" : name.includes("validation") && (/recipient/.test(detail) || /\bto (email|address)\b/.test(detail)) ? "invalid_recipient" : name.includes("validation") ? "policy" : name.includes("auth") ? "authentication" : "provider";
        throw new CanonicalProviderError(result.error.message, category, name, "not_accepted", category === "rate_limit" || category === "provider");
      }
      return accepted(result.data?.id);
    }
  },
  webhook: {
    async verify(request, _context, security) {
      const secret = typeof security.signingSecret === "string" ? security.signingSecret : "";
      if (!secret) return { valid: false, replaySafe: false, nativeType: "unknown", parsed: null };
      try {
        const body = new TextDecoder().decode(request.rawBody);
        new Webhook(secret).verify(body, {
          "svix-id": header(request.headers, "svix-id"),
          "svix-timestamp": header(request.headers, "svix-timestamp"),
          "svix-signature": header(request.headers, "svix-signature")
        });
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const timestamp = Number(header(request.headers, "svix-timestamp"));
        return {
          valid: true,
          replaySafe: Number.isFinite(timestamp) && Math.abs(Date.now() / 1000 - timestamp) < 300,
          providerEventId: header(request.headers, "svix-id"),
          nativeType: String(parsed.type ?? "unknown"),
          parsed
        };
      } catch {
        return { valid: false, replaySafe: false, nativeType: "unknown", parsed: null };
      }
    },
    async normalize(verified) {
      const payload = verified.parsed as { type?: string; created_at?: string; data?: Record<string, unknown> };
      const type = eventMap[String(payload.type)];
      if (!type) return [];
      const data = payload.data ?? {};
      const bounce = data.bounce as { type?: string; message?: string } | undefined;
      return [event({
        id: verified.providerEventId ?? crypto.randomUUID(),
        externalMessageId: typeof data.email_id === "string" ? data.email_id : undefined,
        type,
        occurredAt: new Date(payload.created_at ?? Date.now()),
        recipient: Array.isArray(data.to) ? String(data.to[0]) : undefined,
        bounce: type === "bounced" ? {
          classification: bounce?.type === "Permanent" ? "hard" : "soft",
          message: bounce?.message
        } : undefined,
        inboundReference: type === "inbound.received" ? String(data.email_id) : undefined,
        metadata: {}
      })];
    },
  },
  identity: {
    async createIdentity(domain, context) {
      const result = await client(context.secret).domains.create({ name: domain, region: "us-east-1" });
      if (result.error || !result.data) throw new Error(result.error?.message ?? "Identity creation failed");
      return { externalIdentityId: result.data.id, status: result.data.status, dnsRecords: result.data.records ?? [] };
    },
    async checkIdentity(id, context) {
      const result = await client(context.secret).domains.get(id);
      if (result.error || !result.data) throw new Error(result.error?.message ?? "Identity lookup failed");
      return { status: result.data.status, dnsRecords: result.data.records ?? [] };
    },
  },
  inbound: {
    async receive(verified, context) {
      const payload = verified.parsed as { data?: { email_id?: string } };
      const id = payload.data?.email_id;
      if (!id) return null;
      const result = await client(context.secret).emails.receiving.get(id, { html_format: "cid" });
      if (result.error || !result.data) throw new Error(result.error?.message ?? "Inbound retrieval failed");
      return {
        externalMessageId: id,
        messageId: result.data.message_id,
        from: result.data.from,
        to: result.data.to,
        cc: result.data.cc ?? [],
        bcc: result.data.bcc ?? [],
        subject: result.data.subject,
        html: result.data.html ?? undefined,
        text: result.data.text ?? undefined,
        attachments: [],
        receivedAt: new Date()
      };
    }
  },
  reconciliation: {
    async reconcile(externalMessageId, _fingerprint, context) {
      if (!externalMessageId) return "unknown";
      const result = await client(context.secret).emails.get(externalMessageId);
      return result.data ? "accepted" : result.error?.name === "not_found" ? "not_accepted" : "unknown";
    }
  },
  health: {
    async check(context) {
      const result = await client(context.secret).domains.list();
      return {
        healthy: !result.error,
        details: { domainCount: result.data?.data.length ?? 0, error: result.error?.message }
      }
    }
  },
};
