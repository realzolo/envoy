import { z } from "zod";

export const providerTypeSchema = z.enum(["resend", "ses", "sendgrid", "mailgun", "postmark", "mock"]);
export type ProviderType = z.infer<typeof providerTypeSchema>;

const baseConfig = { schemaVersion: z.literal(1) };
export const providerConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resend"), ...baseConfig }).strict(),
  z.object({
    type: z.literal("ses"), ...baseConfig,
    region: z.string().min(2),
    configurationSet: z.string().optional(),
    roleArn: z.string().optional(),
    externalId: z.string().optional()
  }).strict(),
  z.object({
    type: z.literal("sendgrid"), ...baseConfig,
    region: z.enum(["global", "eu"]).default("global")
  }).strict(),
  z.object({
    type: z.literal("mailgun"), ...baseConfig,
    region: z.enum(["us", "eu"]),
    sendingDomain: z.string().min(3)
  }).strict(),
  z.object({
    type: z.literal("postmark"), ...baseConfig,
    messageStream: z.string().default("outbound")
  }).strict(),
  z.object({
    type: z.literal("mock"), ...baseConfig,
    behavior: z.enum(["deliver", "defer", "unknown"]).default("deliver")
  }).strict(),
]);
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const providerSecretSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resend"), apiKey: z.string().min(8) }).strict(),
  z.object({
    type: z.literal("ses"),
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
    sessionToken: z.string().optional()
  }).strict().refine((v) => (!v.accessKeyId && !v.secretAccessKey) || (v.accessKeyId && v.secretAccessKey), "Both static AWS credential fields are required"),
  z.object({
    type: z.literal("sendgrid"),
    apiKey: z.string().min(8)
  }).strict(),
  z.object({ type: z.literal("mailgun"), apiKey: z.string().min(8) }).strict(),
  z.object({
    type: z.literal("postmark"),
    serverToken: z.string().min(8)
  }).strict(),
  z.object({ type: z.literal("mock"), token: z.string().default("local-mock") }).strict(),
]);
export type ProviderSecret = z.infer<typeof providerSecretSchema>;

export const providerWebhookSettingsSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resend"), signingSecret: z.string().min(8) }).strict(),
  z.object({ type: z.literal("sendgrid"), publicKey: z.string().min(32) }).strict(),
  z.object({ type: z.literal("mailgun"), webhookSigningKey: z.string().min(8) }).strict(),
  z.object({
    type: z.literal("postmark"),
    username: z.string().min(1),
    password: z.string().min(8),
    ipAllowlist: z.array(z.string().min(1)).default([])
  }).strict(),
  z.object({
    type: z.literal("ses"),
    expectedTopicArn: z.string().regex(/^arn:(?:aws|aws-us-gov|aws-cn):sns:[^:]+:\d{12}:[^:]+$/)
  }).strict(),
  z.object({ type: z.literal("mock") }).strict()
]);
export type ProviderWebhookSettings = z.infer<typeof providerWebhookSettingsSchema>;

export function providerAccountRegion(config: ProviderConfig) {
  if (config.type === "ses" || config.type === "mailgun" || config.type === "sendgrid") return config.region;
  if (config.type === "mock") return "local";
  return "global"
}

export type ProviderCapabilities = {
  nativeIdempotency: boolean;
  inboundMode: "webhook-fetch" | "multipart" | "route" | "object-reference" | "none";
  domainManagement: boolean;
  webhookSecurity: string;
  eventTypes: string[];
  attachments: boolean;
  scheduling: boolean;
};

export type ProviderDescriptor = { type: ProviderType; displayName: string; capabilities: ProviderCapabilities };

export type CanonicalAttachment = { fileName: string; contentType: string; objectKey: string; contentId?: string };
export type CanonicalMessage = {
  deliveryId: string;
  from: { name: string; email: string };
  to: { name?: string; email: string };
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments: CanonicalAttachment[];
  tags: Record<string, string>;
};

export type ProviderSendContext = {
  accountId: string;
  config: ProviderConfig;
  secret: ProviderSecret;
  idempotencyKey?: string
};
export type ProviderSendResult =
  { outcome: "accepted"; externalMessageId: string; response?: Record<string, unknown> }
  | { outcome: "unknown"; reason: string };

export type ErrorCategory =
  "authentication"
  | "rate_limit"
  | "invalid_recipient"
  | "policy"
  | "provider"
  | "network"
  | "unknown";

export class CanonicalProviderError extends Error {
  constructor(message: string, public readonly category: ErrorCategory, public readonly code: string, public readonly outcome: "not_accepted" | "unknown" | "accepted", public readonly retryable: boolean) {
    super(message);
  }
}

export type CanonicalEventType =
  "accepted"
  | "deferred"
  | "delivered"
  | "bounced"
  | "failed"
  | "opened"
  | "clicked"
  | "complained"
  | "unsubscribed"
  | "suppressed"
  | "inbound.received";
export type CanonicalEvent = {
  id: string;
  externalMessageId?: string;
  type: CanonicalEventType;
  occurredAt: Date;
  recipient?: string;
  bounce?: { classification: "hard" | "soft"; code?: string; message?: string };
  inboundReference?: string;
  metadata: Record<string, unknown>;
};

export type WebhookRequest = { rawBody: Uint8Array; headers: Record<string, string>; remoteAddress?: string };
export type WebhookVerification = {
  valid: boolean;
  replaySafe: boolean;
  providerEventId?: string;
  nativeType: string;
  parsed: unknown
};

export type CanonicalInboundMessage = {
  externalMessageId: string;
  messageId?: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html?: string;
  text?: string;
  rawMime?: Uint8Array;
  attachments: Array<{ fileName: string; contentType: string; content: Uint8Array; contentId?: string }>;
  receivedAt: Date;
};

export interface SenderPort {
  send(message: CanonicalMessage, context: ProviderSendContext): Promise<ProviderSendResult>
}

export interface WebhookPort {
  verify(request: WebhookRequest, context: ProviderSendContext, securityConfig: Record<string, unknown>): Promise<WebhookVerification>;

  normalize(verified: WebhookVerification, context: ProviderSendContext): Promise<CanonicalEvent[]>;
}

export interface IdentityPort {
  createIdentity(domain: string, context: ProviderSendContext): Promise<{
    externalIdentityId: string;
    status: string;
    dnsRecords: unknown[]
  }>;

  checkIdentity(externalIdentityId: string, context: ProviderSendContext): Promise<{
    status: string;
    dnsRecords: unknown[]
  }>;
}

export interface InboundPort {
  receive(verified: WebhookVerification, context: ProviderSendContext): Promise<CanonicalInboundMessage | null>
}

export interface SuppressionPort {
  sync(context: ProviderSendContext): Promise<Array<{ email: string; reason: string }>>
}

export interface ReconciliationPort {
  reconcile(externalMessageId: string | null, fingerprint: string, context: ProviderSendContext): Promise<"accepted" | "not_accepted" | "unknown">
}

export interface HealthPort {
  check(context: ProviderSendContext): Promise<{ healthy: boolean; details?: Record<string, unknown> }>
}

export type ProviderModule = {
  descriptor: ProviderDescriptor;
  sender: SenderPort;
  webhook: WebhookPort;
  identity?: IdentityPort;
  inbound?: InboundPort;
  suppression?: SuppressionPort;
  reconciliation?: ReconciliationPort;
  health: HealthPort;
};
