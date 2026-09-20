import { CanonicalProviderError, type ProviderModule } from "../contracts";
import { event } from "../shared";

export const mockModule: ProviderModule = {
  descriptor: {
    type: "mock",
    displayName: "Mock",
    capabilities: {
      nativeIdempotency: true,
      inboundMode: "webhook-fetch",
      domainManagement: true,
      webhookSecurity: "Shared token",
      eventTypes: ["accepted", "delivered", "bounced", "complained", "inbound.received"],
      attachments: true,
      scheduling: false
    }
  },
  sender: {
    async send(message, context) {
      if (context.config.type !== "mock") throw new Error("Invalid mock configuration");
      if (message.to.email.includes("unknown") || context.config.behavior === "unknown") return {
        outcome: "unknown",
        reason: "Simulated response loss"
      };
      if (message.to.email.includes("fail")) throw new CanonicalProviderError("Simulated provider rejection", "provider", "mock_rejected", "not_accepted", false);
      return { outcome: "accepted", externalMessageId: `mock_${crypto.randomUUID()}` };
    }
  },
  webhook: {
    async verify(request, _context, security) {
      const token = typeof security.token === "string" ? security.token : "";
      const parsed = JSON.parse(new TextDecoder().decode(request.rawBody)) as Record<string, unknown>;
      return {
        valid: Boolean(token) && request.headers.authorization === `Bearer ${token}`,
        replaySafe: true,
        providerEventId: String(parsed.id ?? crypto.randomUUID()),
        nativeType: String(parsed.type ?? "unknown"),
        parsed
      };
    }, async normalize(verified) {
      const p = verified.parsed as Record<string, unknown>;
      return [event({
        id: String(p.id),
        externalMessageId: typeof p.externalMessageId === "string" ? p.externalMessageId : undefined,
        type: String(p.type) as "delivered",
        occurredAt: new Date(String(p.occurredAt ?? new Date().toISOString())),
        recipient: typeof p.recipient === "string" ? p.recipient : undefined
      })];
    }
  },
  identity: {
    async createIdentity(domain) {
      return { externalIdentityId: `mock_identity_${domain}`, status: "verified", dnsRecords: [] }
    }, async checkIdentity() {
      return { status: "verified", dnsRecords: [] }
    }
  },
  inbound: {
    async receive(verified) {
      if (verified.nativeType !== "inbound.received") return null;
      const p = verified.parsed as Record<string, unknown>;
      const to = Array.isArray(p.to) ? p.to.map(String) : typeof p.to === "string" ? [p.to] : [];
      const attachments = Array.isArray(p.attachments) ? p.attachments.flatMap(item => {
        const file = item as Record<string, unknown>;
        if (typeof file.contentBase64 !== "string") return [];
        return [{
          fileName: String(file.fileName ?? "attachment"),
          contentType: String(file.contentType ?? "application/octet-stream"),
          content: new Uint8Array(Buffer.from(file.contentBase64, "base64")),
          contentId: typeof file.contentId === "string" ? file.contentId : undefined
        }]
      }) : [];
      return {
        externalMessageId: String(p.externalMessageId ?? p.id ?? crypto.randomUUID()),
        messageId: typeof p.messageId === "string" ? p.messageId : undefined,
        from: String(p.from ?? "sender@example.net"),
        to,
        cc: Array.isArray(p.cc) ? p.cc.map(String) : [],
        bcc: Array.isArray(p.bcc) ? p.bcc.map(String) : [],
        subject: String(p.subject ?? ""),
        html: typeof p.html === "string" ? p.html : undefined,
        text: typeof p.text === "string" ? p.text : undefined,
        rawMime: typeof p.rawMimeBase64 === "string" ? new Uint8Array(Buffer.from(p.rawMimeBase64, "base64")) : undefined,
        attachments,
        receivedAt: new Date(String(p.occurredAt ?? new Date().toISOString()))
      }
    }
  },
  reconciliation: {
    async reconcile(externalId) {
      return externalId ? "accepted" : "unknown"
    }
  },
  health: {
    async check() {
      return { healthy: true, details: { mode: "local" } }
    }
  },
};
