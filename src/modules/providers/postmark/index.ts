import { inboundHeaders } from "../inbound-fields";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { CanonicalProviderError, type CanonicalEventType, type ProviderModule } from "../contracts";
import { nativeMailCapabilities, assertMessageCapabilities, formatAddress, messageHeaders, safeDiagnostic, accepted, submitRequest, eventDate, stableEventId, checkedJson, decodeJson, event, header } from "../shared";

const eventMap: Record<string, CanonicalEventType> = {
  Delivery: "delivered",
  Bounce: "bounced",
  Open: "opened",
  Click: "clicked",
  SpamComplaint: "complained",
  SubscriptionChange: "unsubscribed",
  Inbound: "inbound.received"
};
const payloadSchema = z.object({
  RecordType: z.string().optional(),
  MessageID: z.string().optional(),
  Recipient: z.string().optional(),
  DeliveredAt: z.string().optional(),
  BouncedAt: z.string().optional()
}).passthrough();
export const postmarkModule: ProviderModule = {
  descriptor: {
    type: "postmark",
    displayName: "Postmark",
    capabilities: {
      nativeIdempotency: false,
      inboundMode: "json",
      domainManagement: false,
      webhookSecurity: "Basic Auth, opaque URL, IP allowlist, schema validation",
      eventTypes: Object.keys(eventMap),
      ...nativeMailCapabilities,
      inboundEnvelopeRecipients: true,
      scheduling: false
    }
  },
  sender: {
    async send(message, context) {
      assertMessageCapabilities(message, postmarkModule.descriptor.capabilities);
      if (context.config.type !== "postmark" || context.secret.type !== "postmark") throw new Error("Invalid Postmark configuration");
      const response = await submitRequest("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { "x-postmark-server-token": context.secret.serverToken, "content-type": "application/json" },
        body: JSON.stringify({
          From: formatAddress(message.from),
          To: message.to.map(formatAddress).join(", "),
          Cc: message.cc.length ? message.cc.map(formatAddress).join(", ") : undefined,
          Bcc: message.bcc.length ? message.bcc.map(formatAddress).join(", ") : undefined,
          ReplyTo: message.replyTo.length ? message.replyTo.map(formatAddress).join(", ") : undefined,
          Subject: message.subject,
          HtmlBody: message.html,
          TextBody: message.text,
          Headers: Object.entries(messageHeaders(message)).map(([Name, Value]) => ({ Name, Value })),
          Attachments: message.attachments.map(a => ({ Name: a.fileName, ContentType: a.contentType, Content: Buffer.from(a.content).toString("base64"), ...(a.disposition === "inline" ? { ContentID: `cid:${a.contentId}` } : {}) })),
          MessageStream: context.config.messageStream,
          Metadata: message.tags
        })
      });
      const body = await checkedJson(response);
      if (body.ErrorCode !== undefined && body.ErrorCode !== 0) throw new CanonicalProviderError(safeDiagnostic(body.Message), "policy", "PROVIDER_POLICY_REJECTED", "not_accepted", false, { providerCode: String(body.ErrorCode) });
      return accepted(body.MessageID);
    }
  },
  webhook: {
    async verify(request, context, security) {
      if (context.secret.type !== "postmark") throw new Error("Invalid Postmark credential");
      const allowed = Array.isArray(security.ipAllowlist) ? security.ipAllowlist.map(String) : [];
      const ipValid = !allowed.length || Boolean(request.remoteAddress && allowed.includes(request.remoteAddress));
      const username = typeof security.username === "string" ? security.username : "";
      const password = typeof security.password === "string" ? security.password : "";
      const expected = username && password ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` : "";
      const actual = header(request.headers, "authorization");
      const authValid = Boolean(expected) && actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
      let parsed: unknown = null;
      let schemaValid = false;
      try {
        parsed = decodeJson(request.rawBody);
        const candidate = parsed as Record<string, unknown>;
        if (!candidate.RecordType && typeof candidate.MessageID === "string" && typeof candidate.From === "string" && typeof candidate.OriginalRecipient === "string") candidate.RecordType = "Inbound";
        schemaValid = Boolean(candidate.RecordType) && payloadSchema.safeParse(parsed).success
      } catch {
      }
      const p = (parsed ?? {}) as Record<string, unknown>;
      return {
        valid: ipValid && authValid && schemaValid,
        replaySafe: true,
        providerEventId: typeof p.ID === "number" ? `${p.RecordType}:${p.ID}` : stableEventId(p),
        nativeType: String(p.RecordType ?? "unknown"),
        parsed
      };
    }, async normalize(verified) {
      const p = verified.parsed as Record<string, unknown>;
      const type = eventMap[String(p.RecordType)];
      if (!type) return [];
      return [event({
        id: verified.providerEventId ?? stableEventId(p),
        externalMessageId: typeof p.MessageID === "string" ? p.MessageID : undefined,
        type,
        occurredAt: eventDate(p.DeliveredAt ?? p.BouncedAt ?? p.ReceivedAt ?? p.Date ?? p.ChangedAt),
        recipient: typeof p.Recipient === "string" ? p.Recipient : typeof p.Email === "string" ? p.Email : undefined,
        bounce: type === "bounced" ? {
          classification: p.Type === "HardBounce" || p.TypeCode === 1 || p.Type === "BadEmailAddress" || p.TypeCode === 100000 ? "hard" : "soft",
          code: String(p.TypeCode ?? p.Type ?? ""),
          message: String(p.Description ?? p.Details ?? "")
        } : undefined
      })]
    }
  },
  inbound: {
    async receive(verified) {
      const p = verified.parsed as Record<string, unknown>;
      if (p.RecordType !== "Inbound") return null;
      const attachments = Array.isArray(p.Attachments) ? p.Attachments.flatMap(item => {
        const a = item as Record<string, unknown>;
        if (typeof a.Content !== "string") return [];
        return [{
          fileName: String(a.Name ?? "attachment"),
          contentType: String(a.ContentType ?? "application/octet-stream"),
          content: new Uint8Array(Buffer.from(a.Content, "base64")),
          contentId: typeof a.ContentID === "string" ? a.ContentID : undefined
        }]
      }) : [];
      const fields = await inboundHeaders(p.Headers);
      return {
        externalMessageId: String(p.MessageID ?? verified.providerEventId ?? crypto.randomUUID()),
        ...fields,
        envelopeRecipients: typeof p.OriginalRecipient === "string" ? [p.OriginalRecipient] : undefined,
        replyTo: p.ReplyTo ? (await inboundHeaders(`Reply-To: ${String(p.ReplyTo)}`)).replyTo : fields.replyTo,
        from: String(p.From ?? ""),
        to: Array.isArray(p.ToFull) ? p.ToFull.map(item => String((item as Record<string, unknown>).Email ?? "")) : (await inboundHeaders(`To: ${String(p.To ?? "")}`)).to,
        cc: Array.isArray(p.CcFull) ? p.CcFull.map(item => String((item as Record<string, unknown>).Email ?? "")) : (await inboundHeaders(`Cc: ${String(p.Cc ?? "")}`)).cc,
        bcc: Array.isArray(p.BccFull) ? p.BccFull.map(item => String((item as Record<string, unknown>).Email ?? "")) : String(p.Bcc ?? "").split(",").filter(Boolean),
        subject: String(p.Subject ?? ""),
        html: typeof p.HtmlBody === "string" ? p.HtmlBody : undefined,
        text: typeof p.TextBody === "string" ? p.TextBody : undefined,
        attachments,
        receivedAt: new Date(String(p.Date ?? new Date().toISOString()))
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
      if (context.config.type !== "postmark" || context.secret.type !== "postmark") throw new Error("Invalid Postmark configuration");
      const response = await fetch("https://api.postmarkapp.com/server", { headers: { "x-postmark-server-token": context.secret.serverToken } });
      return { healthy: response.ok, details: { status: response.status } }
    }
  },
};
