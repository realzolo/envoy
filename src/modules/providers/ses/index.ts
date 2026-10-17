import { declaredAuthorDate, mailAddresses, smtpRecipients } from "../inbound-fields";
import { createVerify } from "node:crypto";
import {
  CreateEmailIdentityCommand,
  GetAccountCommand,
  GetEmailIdentityCommand,
  SendEmailCommand,
  SESv2Client
} from "@aws-sdk/client-sesv2";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { simpleParser } from "mailparser";
import {
  type CanonicalEventType,
  CanonicalProviderError,
  type ProviderModule,
  type ProviderSendContext
} from "../contracts";
import { nativeMailCapabilities, assertMessageCapabilities, buildMimeMessage, messageRecipients, safeDiagnostic, providerErrorCode, accepted, decodeJson, event, eventDate, stableEventId } from "../shared";
import { isTrustedSnsSigningCertificateUrl, snsSignatureAlgorithm } from "./sns-security";

function credentials(context: ProviderSendContext) {
  if (context.config.type !== "ses" || context.secret.type !== "ses") throw new Error("Invalid SES configuration");
  if (context.config.roleArn) return fromTemporaryCredentials({
    params: {
      RoleArn: context.config.roleArn,
      ExternalId: context.config.externalId,
      RoleSessionName: `envoy-${context.accountId}`
    },
    masterCredentials: context.secret.accessKeyId && context.secret.secretAccessKey ? {
      accessKeyId: context.secret.accessKeyId,
      secretAccessKey: context.secret.secretAccessKey,
      sessionToken: context.secret.sessionToken
    } : undefined
  });
  return context.secret.accessKeyId && context.secret.secretAccessKey ? {
    accessKeyId: context.secret.accessKeyId,
    secretAccessKey: context.secret.secretAccessKey,
    sessionToken: context.secret.sessionToken
  } : undefined;
}

function ses(context: ProviderSendContext) {
  if (context.config.type !== "ses") throw new Error("Invalid SES configuration");
  return new SESv2Client({ region: context.config.region, credentials: credentials(context), maxAttempts: 1, requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 } })
}

function snsString(payload: Record<string, unknown>) {
  const keys = payload.Type === "Notification" ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  return keys.filter(k => payload[k] !== undefined).map(k => `${k}\n${String(payload[k])}\n`).join("")
}

async function verifySns(payload: Record<string, unknown>, expectedTopicArn: string) {
  const url = String(payload.SigningCertURL ?? "");
  const algorithm = snsSignatureAlgorithm(payload.SignatureVersion);
  if (!algorithm || !isTrustedSnsSigningCertificateUrl(url, expectedTopicArn) || String(payload.TopicArn) !== expectedTopicArn) return false;
  const certificate = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000)
  }).then(async r => {
    if (!r.ok) throw new Error("SNS certificate fetch failed");
    const contentLength = Number(r.headers.get("content-length") ?? 0);
    if (contentLength > 64 * 1024) throw new Error("SNS certificate is too large");
    const text = await r.text();
    if (text.length > 64 * 1024) throw new Error("SNS certificate is too large");
    return text
  });
  const verifier = createVerify(algorithm);
  verifier.update(snsString(payload));
  verifier.end();
  return verifier.verify(certificate, String(payload.Signature), "base64")
}

const eventMap: Record<string, CanonicalEventType> = {
  Send: "accepted",
  Delivery: "delivered",
  DeliveryDelay: "deferred",
  Bounce: "bounced",
  Reject: "failed",
  Open: "opened",
  Click: "clicked",
  Complaint: "complained",
  RenderingFailure: "failed",
  "Rendering Failure": "failed",
  Subscription: "unsubscribed",
  Received: "inbound.received"
};

export const sesModule: ProviderModule = {
  descriptor: {
    type: "ses",
    displayName: "Amazon SES",
    capabilities: {
      nativeIdempotency: false,
      inboundMode: "object-reference",
      domainManagement: true,
      webhookSecurity: "SNS certificate signature and TopicArn",
      eventTypes: Object.keys(eventMap),
      ...nativeMailCapabilities,
      inboundEnvelopeRecipients: true,
      envelopeRecipients: true,
      requiresTo: false,
      maxMessageBytes: 40_000_000,
      scheduling: false
    }
  },
  sender: {
    async send(message, context) {
      assertMessageCapabilities(message, sesModule.descriptor.capabilities);
      if (context.config.type !== "ses") throw new Error("Invalid SES configuration");
      try {
        const result = await ses(context).send(new SendEmailCommand({
          FromEmailAddress: message.from.email,
          // Destination is the SMTP envelope. Visible To/Cc remain in MIME;
          // Bcc is omitted from MIME and only appears in this envelope.
          Destination: { ToAddresses: messageRecipients(message).map(a => a.email) },
          Content: { Raw: { Data: buildMimeMessage(message) } },
          ConfigurationSetName: context.config.configurationSet,
          EmailTags: Object.entries(message.tags).map(([Name, Value]) => ({ Name, Value }))
        }));
        return accepted(result.MessageId)
      } catch (error) {
        if (error instanceof CanonicalProviderError) throw error;
        const value = error as { $metadata?: { httpStatusCode?: number }; name?: string; message?: string };
        const status = value.$metadata?.httpStatusCode;
        const details = { providerCode: value.name ?? `http_${status ?? "unknown"}` };
        if (!status) throw new CanonicalProviderError(safeDiagnostic(value.message ?? "SES request outcome is unknown"), "network", "SUBMISSION_OUTCOME_UNKNOWN", "unknown", false, details);
        if (status >= 500 || status === 408) throw new CanonicalProviderError(safeDiagnostic(value.message ?? `SES returned HTTP ${status}`), "provider", "SUBMISSION_OUTCOME_UNKNOWN", "unknown", false, details);
        const category = status === 429 ? "rate_limit" : status === 401 || status === 403 ? "authentication" : status >= 500 ? "provider" : "policy";
        throw new CanonicalProviderError(safeDiagnostic(value.message ?? `SES returned HTTP ${status}`), category, providerErrorCode(category), "not_accepted", status === 429, details)
      }
    }
  },
  webhook: {
    async verify(request, _context, security) {
      const expected = typeof security.expectedTopicArn === "string" ? security.expectedTopicArn : "";
      let parsed: Record<string, unknown>;
      try {
        parsed = decodeJson(request.rawBody)
      } catch {
        return { valid: false, replaySafe: false, nativeType: "unknown", parsed: null }
      }
      ;let valid = false;
      try {
        valid = Boolean(expected) && await verifySns(parsed, expected)
      } catch {
      }
      const timestamp = new Date(String(parsed.Timestamp ?? 0)).getTime();
      let nativeType = String(parsed.Type ?? "unknown");
      if (parsed.Type === "Notification") {
        try {
          const nested = JSON.parse(String(parsed.Message)) as Record<string, unknown>;
          nativeType = String(nested.eventType ?? nested.notificationType ?? "unknown")
        } catch {
        }
      }
      return {
        valid,
        replaySafe: Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) < 5 * 60_000,
        providerEventId: typeof parsed.MessageId === "string" ? parsed.MessageId : undefined,
        nativeType,
        parsed
      };
    }, async normalize(verified) {
      const envelope = verified.parsed as Record<string, unknown>;
      if (envelope.Type !== "Notification") return [];
      const p = JSON.parse(String(envelope.Message)) as Record<string, unknown>;
      const native = String(p.eventType ?? p.notificationType ?? "");
      const type = eventMap[native];
      if (!type) return [];
      const mail = (p.mail ?? {}) as Record<string, unknown>;
      const detailsKey: Record<string, string> = { Delivery: "delivery", Bounce: "bounce", Complaint: "complaint", Reject: "reject", RenderingFailure: "failure", "Rendering Failure": "failure", DeliveryDelay: "deliveryDelay", Open: "open", Click: "click", Send: "send", Subscription: "subscription", Received: "receipt" };
      const details = (p[detailsKey[native]] ?? {}) as Record<string, unknown>;
      const recipientsKey = native === "Bounce" ? "bouncedRecipients" : native === "Complaint" ? "complainedRecipients" : native === "DeliveryDelay" ? "delayedRecipients" : "recipients";
      // Open/Click only identify a message: mail.destination does not prove
      // which member of a grouped email engaged with it.
      const engagement = type === "opened" || type === "clicked";
      const recipients = engagement ? [] : Array.isArray(details[recipientsKey]) ? details[recipientsKey] as unknown[] : Array.isArray(mail.destination) ? mail.destination : [];
      const occurredAt = eventDate(details.timestamp ?? mail.timestamp);
      return (recipients.length ? recipients : [undefined]).map((recipient, index) => {
        const info = recipient && typeof recipient === "object" ? recipient as Record<string, unknown> : {};
        const email = typeof recipient === "string" ? recipient : typeof info.emailAddress === "string" ? info.emailAddress : undefined;
        return event({
          id: `${verified.providerEventId ?? stableEventId(p)}:${email ?? index}`,
          externalMessageId: typeof mail.messageId === "string" ? mail.messageId : undefined,
          type,
          occurredAt,
          recipient: email,
          bounce: type === "bounced" ? {
            classification: details.bounceType === "Permanent" ? "hard" : "soft",
            code: String(info.status ?? details.bounceSubType ?? ""),
            message: typeof info.diagnosticCode === "string" ? info.diagnosticCode : undefined
          } : undefined,
          metadata: type === "failed" || type === "deferred" ? {
            reason: safeDiagnostic(info.diagnosticCode ?? details.reason ?? details.errorMessage ?? details.delayType ?? "Provider delivery failed"),
            ...(info.status || details.errorCode ? { providerCode: String(info.status ?? details.errorCode) } : {}),
          } : {},
          inboundReference: type === "inbound.received" ? String(mail.messageId ?? "") : undefined
        });
      });
    }
  },
  identity: {
    async createIdentity(domain, context) {
      const result = await ses(context).send(new CreateEmailIdentityCommand({ EmailIdentity: domain }));
      return {
        externalIdentityId: domain,
        status: result.VerifiedForSendingStatus ? "verified" : "pending",
        dnsRecords: result.DkimAttributes?.Tokens?.map(token => ({
          type: "CNAME",
          name: `${token}._domainkey.${domain}`,
          value: `${token}.dkim.amazonses.com`
        })) ?? []
      }
    }, async checkIdentity(id, context) {
      const result = await ses(context).send(new GetEmailIdentityCommand({ EmailIdentity: id }));
      return {
        status: result.VerifiedForSendingStatus ? "verified" : "pending",
        dnsRecords: result.DkimAttributes?.Tokens?.map(token => ({
          type: "CNAME",
          name: `${token}._domainkey.${id}`,
          value: `${token}.dkim.amazonses.com`
        })) ?? []
      }
    }
  },
  inbound: {
    async receive(verified, context) {
      if (context.config.type !== "ses") throw new Error("Invalid SES configuration");
      const envelope = verified.parsed as Record<string, unknown>;
      const payload = JSON.parse(String(envelope.Message)) as Record<string, unknown>;
      const receipt = (payload.receipt ?? {}) as Record<string, unknown>;
      const action = Array.isArray(receipt.action) ? receipt.action[0] as Record<string, unknown> : receipt.action as Record<string, unknown> | undefined;
      const mail = (payload.mail ?? {}) as Record<string, unknown>;
      if (!action || action.type !== "S3" || typeof action.bucketName !== "string" || typeof action.objectKey !== "string") return null;
      const object = await new S3Client({
        region: context.config.region,
        credentials: credentials(context)
      }).send(new GetObjectCommand({ Bucket: action.bucketName, Key: action.objectKey }));
      if (!object.Body) throw new Error("SES inbound object is empty");
      const bytes = await object.Body.transformToByteArray();
      const parsed = await simpleParser(Buffer.from(bytes));
      return {
        externalMessageId: String(mail.messageId ?? action.objectKey),
        messageId: parsed.messageId,
        envelopeRecipients: smtpRecipients(receipt.recipients),
        replyTo: mailAddresses(parsed.replyTo), inReplyTo: parsed.inReplyTo,
        references: typeof parsed.references === "string" ? [parsed.references] : parsed.references ?? [],
        from: parsed.from?.text ?? "",
        to: mailAddresses(parsed.to),
        cc: mailAddresses(parsed.cc),
        bcc: mailAddresses(parsed.bcc),
        subject: parsed.subject ?? "",
        html: typeof parsed.html === "string" ? parsed.html : undefined,
        text: parsed.text,
        rawMime: bytes,
        attachments: parsed.attachments.map(a => ({
          fileName: a.filename ?? "attachment",
          contentType: a.contentType,
          content: new Uint8Array(a.content),
          contentId: a.cid
        })),
        authorDate: declaredAuthorDate(parsed),
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
      const result = await ses(context).send(new GetAccountCommand({}));
      return {
        healthy: result.ProductionAccessEnabled !== undefined,
        details: { productionAccess: result.ProductionAccessEnabled, sendingEnabled: result.SendingEnabled }
      }
    }
  },
};
