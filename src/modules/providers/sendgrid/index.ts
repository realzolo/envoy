import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import type { CanonicalEventType, ProviderModule } from "../contracts";
import { accepted, checkedJson, event, header, type MultipartValue, parseMultipart } from "../shared";

const eventMap: Record<string, CanonicalEventType> = {
  processed: "accepted",
  delivered: "delivered",
  deferred: "deferred",
  bounce: "bounced",
  dropped: "failed",
  open: "opened",
  click: "clicked",
  spamreport: "complained",
  unsubscribe: "unsubscribed"
};

function apiBase(region: "global" | "eu") {
  return region === "eu" ? "https://api.eu.sendgrid.com" : "https://api.sendgrid.com"
}

export const sendgridModule: ProviderModule = {
  descriptor: {
    type: "sendgrid",
    displayName: "SendGrid",
    capabilities: {
      nativeIdempotency: false,
      inboundMode: "multipart",
      domainManagement: false,
      webhookSecurity: "ECDSA signature or OAuth",
      eventTypes: Object.keys(eventMap),
      attachments: false,
      scheduling: false
    }
  },
  sender: {
    async send(message, context) {
      if (context.config.type !== "sendgrid" || context.secret.type !== "sendgrid") throw new Error("Invalid SendGrid configuration");
      const response = await fetch(`${apiBase(context.config.region)}/v3/mail/send`, {
        method: "POST",
        headers: { authorization: `Bearer ${context.secret.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          personalizations: [{
            to: [{ email: message.to.email, name: message.to.name }],
            custom_args: message.tags
          }],
          from: message.from,
          reply_to: message.replyTo ? { email: message.replyTo } : undefined,
          subject: message.subject,
          content: [{ type: "text/plain", value: message.text }, { type: "text/html", value: message.html }]
        })
      });
      if (!response.ok) await checkedJson(response);
      return accepted(response.headers.get("x-message-id"));
    }
  },
  webhook: {
    async verify(request, _context, security) {
      const contentType = header(request.headers, "content-type");
      const inbound = contentType.includes("multipart/form-data");
      const publicKey = typeof security[inbound ? "inboundParsePublicKey" : "eventWebhookPublicKey"] === "string"
        ? String(security[inbound ? "inboundParsePublicKey" : "eventWebhookPublicKey"])
        : "";
      const signature = header(request.headers, "x-twilio-email-event-webhook-signature");
      const timestamp = header(request.headers, "x-twilio-email-event-webhook-timestamp");
      if (!publicKey || !signature || !timestamp) return {
        valid: false,
        replaySafe: false,
        nativeType: "unknown",
        parsed: null
      };
      let valid = false;
      try {
        valid = verifySignature("sha256", Buffer.concat([Buffer.from(timestamp), Buffer.from(request.rawBody)]), createPublicKey(publicKey), Buffer.from(signature, "base64"))
      } catch {
      }
      const replaySafe = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
      if (inbound) {
        const parsed = await parseMultipart(request.rawBody, contentType);
        return {
          valid,
          replaySafe,
          providerEventId: createHash("sha256").update(request.rawBody).digest("hex"),
          nativeType: "inbound",
          parsed
        }
      }
      const parsed = JSON.parse(new TextDecoder().decode(request.rawBody)) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [];
      const first = rows[0] as Record<string, unknown> | undefined;
      return {
        valid,
        replaySafe,
        providerEventId: first?.sg_event_id ? String(first.sg_event_id) : undefined,
        nativeType: first?.event ? String(first.event) : "batch",
        parsed
      };
    }, async normalize(verified) {
      if (verified.nativeType === "inbound") return [event({
        id: verified.providerEventId ?? crypto.randomUUID(),
        type: "inbound.received",
        occurredAt: new Date(),
        inboundReference: verified.providerEventId
      })];
      const rows = verified.parsed as Array<Record<string, unknown>>;
      return rows.flatMap(row => {
        const type = eventMap[String(row.event)];
        if (!type) return [];
        return [event({
          id: String(row.sg_event_id ?? crypto.randomUUID()),
          externalMessageId: typeof row.sg_message_id === "string" ? row.sg_message_id.split(".")[0] : undefined,
          type,
          occurredAt: new Date(Number(row.timestamp ?? Date.now() / 1000) * 1000),
          recipient: typeof row.email === "string" ? row.email : undefined,
          bounce: type === "bounced" ? {
            classification: String(row.type).includes("bounce") ? "hard" : "soft",
            message: String(row.reason ?? "")
          } : undefined
        })]
      })
    }
  },
  inbound: {
    async receive(verified) {
      if (verified.nativeType !== "inbound") return null;
      const p = verified.parsed as Record<string, MultipartValue | MultipartValue[]>;
      const text = (key: string) => typeof p[key] === "string" ? p[key] as string : "";
      const files = Object.entries(p).filter(([key, value]) => key.startsWith("attachment") && !Array.isArray(value) && typeof value !== "string").map(([, value]) => {
        const file = value as Exclude<MultipartValue, string>;
        return { fileName: file.name, contentType: file.type, content: file.bytes }
      });
      return {
        externalMessageId: verified.providerEventId ?? crypto.randomUUID(),
        from: text("from"),
        to: text("to").split(",").filter(Boolean),
        cc: text("cc").split(",").filter(Boolean),
        bcc: [],
        subject: text("subject"),
        html: text("html"),
        text: text("text"),
        rawMime: undefined,
        attachments: files,
        receivedAt: new Date()
      }
    }
  },
  reconciliation: {
    async reconcile() {
      return "unknown"
    }
  },
  health: {
    async check(context) {
      if (context.config.type !== "sendgrid" || context.secret.type !== "sendgrid") throw new Error("Invalid SendGrid configuration");
      // A deliberately invalid Mail Send request validates the permission Envoy
      // actually needs without delivering a probe email or requiring profile.read.
      const response = await fetch(`${apiBase(context.config.region)}/v3/mail/send`, {
        method: "POST",
        headers: { authorization: `Bearer ${context.secret.apiKey}`, "content-type": "application/json" },
        body: "{}"
      });
      return { healthy: [400, 202, 429].includes(response.status), details: { status: response.status } }
    }
  },
};
