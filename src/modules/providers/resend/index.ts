import { Resend } from "resend";
import { Webhook } from "svix";
import { type CanonicalEventType, type ManagedIdentityStatus, type ProviderModule } from "../contracts";
import { accepted, checkedJson, submitRequest, eventDate, event, header, stableEventId } from "../shared";

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

// Resend exposes richer domain states than Envoy's routing model. A partially
// verified domain must remain ineligible for sending until all required DNS is ready.
export function resendIdentityStatus(status: string): ManagedIdentityStatus {
  if (status === "verified") return "verified";
  if (status === "failed") return "failed";
  return "pending";
}

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
      attachments: false,
      scheduling: false
    }
  },
  sender: {
    async send(message, context) {
      if (context.config.type !== "resend") throw new Error("Invalid Resend configuration");
      if (context.secret.type !== "resend") throw new Error("Invalid Resend credential");
      const response = await submitRequest("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${context.secret.apiKey}`, "content-type": "application/json", ...(context.idempotencyKey ? { "idempotency-key": context.idempotencyKey } : {}) },
        body: JSON.stringify({
          from: `${message.from.name} <${message.from.email}>`,
          to: message.to.name ? `${message.to.name} <${message.to.email}>` : message.to.email,
          reply_to: message.replyTo,
          subject: message.subject,
          html: message.html,
          text: message.text,
          tags: Object.entries(message.tags).map(([name, value]) => ({ name, value }))
        })
      });
      const body = await checkedJson(response);
      return accepted(body.id);
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
        id: verified.providerEventId ?? stableEventId(payload),
        externalMessageId: typeof data.email_id === "string" ? data.email_id : undefined,
        type,
        occurredAt: eventDate(payload.created_at),
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
      const resend = client(context.secret);
      let after: string | undefined;
      for (;;) {
        const listed = await resend.domains.list({ limit: 100, ...(after ? { after } : {}) });
        if (listed.error || !listed.data) throw new Error(listed.error?.message ?? "Domain lookup failed");
        const existing = listed.data.data.find(item => item.name.toLowerCase() === domain.toLowerCase());
        if (existing) {
          const result = await resend.domains.get(existing.id);
          if (result.error || !result.data) throw new Error(result.error?.message ?? "Identity lookup failed");
          return { externalIdentityId: result.data.id, status: resendIdentityStatus(result.data.status), dnsRecords: result.data.records ?? [] };
        }
        if (!listed.data.has_more) break;
        const next = listed.data.data.at(-1)?.id;
        if (!next || next === after) throw new Error("Domain lookup returned an invalid pagination cursor");
        after = next;
      }
      const result = await resend.domains.create({ name: domain, region: "us-east-1" });
      if (result.error || !result.data) throw new Error(result.error?.message ?? "Identity creation failed");
      return { externalIdentityId: result.data.id, status: resendIdentityStatus(result.data.status), dnsRecords: result.data.records ?? [] };
    },
    async checkIdentity(id, context) {
      const result = await client(context.secret).domains.get(id);
      if (result.error || !result.data) throw new Error(result.error?.message ?? "Identity lookup failed");
      return { status: resendIdentityStatus(result.data.status), dnsRecords: result.data.records ?? [] };
    },
  },
  inbound: {
    async receive(verified, context) {
      const payload = verified.parsed as { data?: { email_id?: string } };
      const id = payload.data?.email_id;
      if (!id) return null;
      const result = await client(context.secret).emails.receiving.get(id, { html_format: "cid" });
      if (result.error || !result.data) throw new Error(result.error?.message ?? "Inbound retrieval failed");
      const attachments = [];
      for (const attachment of result.data.attachments ?? []) {
        const detail = await client(context.secret).emails.receiving.attachments.get({ emailId: id, id: attachment.id });
        if (detail.error || !detail.data) throw new Error(detail.error?.message ?? "Inbound attachment retrieval failed");
        const response = await fetch(detail.data.download_url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
        if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 25_000_000) throw new Error("Inbound attachment download failed or exceeds limit");
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Inbound attachment is empty");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 25_000_000) throw new Error("Inbound attachment exceeds limit");
            chunks.push(value);
          }
        } finally { await reader.cancel(); }
        attachments.push({ fileName: attachment.filename ?? "attachment", contentType: attachment.content_type, content: new Uint8Array(Buffer.concat(chunks)), contentId: attachment.content_id ?? undefined });
      }
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
        attachments,
        receivedAt: eventDate(result.data.created_at)
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
