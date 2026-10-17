import { createHash } from "node:crypto";
import { type CanonicalEvent, type CanonicalMessage, type EmailAddress, type ProviderCapabilities, CanonicalProviderError, type ProviderSendResult } from "./contracts";

export const nativeMailCapabilities = {
  cc: true, bcc: true, replyTo: true, customHeaders: true, threading: true,
  outboundAttachments: true, inlineAttachments: true, envelopeRecipients: false,
  requiresTo: true, maxRecipients: 50, maxMessageBytes: 10_000_000
} as const;

export function formatAddress(address: EmailAddress) {
  return address.name ? `${JSON.stringify(address.name)} <${address.email}>` : address.email;
}

export function messageHeaders(message: CanonicalMessage) {
  return {
    ...message.headers,
    ...(message.inReplyTo ? { "In-Reply-To": message.inReplyTo } : {}),
    ...(message.references.length ? { References: message.references.join(" ") } : {})
  };
}

export function messageRecipients(message: Pick<CanonicalMessage, "to" | "cc" | "bcc" | "envelopeRecipients">) {
  return message.envelopeRecipients ?? [...message.to, ...message.cc, ...message.bcc];
}

/** Conservative encoded size, including MIME and JSON/base64 overhead. */
export function estimatedMessageBytes(message: Pick<CanonicalMessage, "from" | "to" | "cc" | "bcc" | "replyTo" | "subject" | "html" | "text" | "headers" | "attachments">) {
  const { attachments, ...fields } = message;
  return Buffer.byteLength(JSON.stringify(fields), "utf8") * 2 + attachments.reduce((size, attachment) => size + Math.ceil(attachment.content.byteLength / 3) * 4 + 2048, 0) + 8192;
}

export function assertMessageCapabilities(message: CanonicalMessage, capabilities: ProviderCapabilities) {
  const unsupported = (feature: string) => { throw new CanonicalProviderError(`Provider cannot preserve ${feature}`, "policy", "UNSUPPORTED_MAIL_FEATURE", "not_accepted", false, { stage: "routing", providerCode: feature }); };
  if (message.cc.length && !capabilities.cc) unsupported("cc");
  if (message.bcc.length && !capabilities.bcc) unsupported("bcc");
  if (message.replyTo.length && !capabilities.replyTo) unsupported("replyTo");
  if (Object.keys(message.headers).length && !capabilities.customHeaders) unsupported("customHeaders");
  if ((message.inReplyTo || message.references.length) && !capabilities.threading) unsupported("threading");
  if (message.attachments.length && !capabilities.outboundAttachments) unsupported("outboundAttachments");
  if (message.attachments.some(a => a.disposition === "inline") && !capabilities.inlineAttachments) unsupported("inlineAttachments");
  if (message.envelopeRecipients && !capabilities.envelopeRecipients) unsupported("independent envelope recipients");
  if (!message.to.length && capabilities.requiresTo) unsupported("email without a To recipient");
  const recipients = messageRecipients(message);
  if (!recipients.length || recipients.length > capabilities.maxRecipients) unsupported("recipient count");
  if (estimatedMessageBytes(message) > capabilities.maxMessageBytes) unsupported("message size");
  if (capabilities.tagValuePattern && Object.entries(message.tags).some(([key, value]) => !/^[A-Za-z0-9_-]{1,256}$/.test(key) || !new RegExp(capabilities.tagValuePattern!).test(value))) unsupported("native tag characters");
  const headerFields = [message.from, ...message.to, ...message.cc, ...message.bcc, ...message.replyTo, ...recipients];
  if (headerFields.some(a => /[\r\n\u0000]/.test(a.email + (a.name ?? ""))) || /[\r\n\u0000]/.test(message.subject)) unsupported("unsafe header values");
  for (const [name, value] of Object.entries(messageHeaders(message))) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || /[\r\n\u0000]/.test(value) || /^(?:to|cc|bcc|from|sender|subject|reply-to|return-path|received|dkim-signature|authentication-results|content-.+|mime-version|date|message-id)$/i.test(name)) unsupported("reserved or unsafe headers");
    if (!/[^\x20-\x7e]/.test(value) && value.split(/\s+/).some(token => Buffer.byteLength(token) > 997)) unsupported("RFC header line length");
  }
  if (message.attachments.some(a => /[\r\n\u0000]/.test(a.fileName + a.contentType + (a.contentId ?? "")) || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(a.contentType) || (a.disposition === "inline" && !a.contentId))) unsupported("invalid attachment metadata");
}

export function safeDiagnostic(value: unknown) {
  return String(value ?? "Provider request failed")
    .replace(/(?:Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/gi, "[redacted credential]")
    .replace(/\b(?:re_|SG\.|key-)[A-Za-z0-9_.-]{8,}/g, "[redacted credential]")
    .replace(/\b(?:api[_-]?key|token|password|secret)(?:["']?\s*[:=]\s*["']?)[^\s,;}"']+/gi, "credential=[redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .slice(0, 2000);
}

export function providerErrorCode(category: string, unknown = false) {
  if (unknown) return "SUBMISSION_OUTCOME_UNKNOWN";
  return ({ authentication: "PROVIDER_AUTHENTICATION_FAILED", rate_limit: "PROVIDER_RATE_LIMITED", invalid_recipient: "INVALID_RECIPIENT", policy: "PROVIDER_POLICY_REJECTED", provider: "PROVIDER_REJECTED", network: "PROVIDER_UNAVAILABLE" } as Record<string, string>)[category] ?? "PROVIDER_REJECTED";
}

const crlf = "\r\n";
function encodedWords(value: string) {
  // 42 UTF-8 bytes leaves each RFC 2047 encoded word below 75 characters.
  const chunks: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, "utf8") > 42) { chunks.push(chunk); chunk = ""; }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map(c => `=?UTF-8?B?${Buffer.from(c).toString("base64")}?=`).join(`${crlf} `);
}
function mimeAddress(address: EmailAddress) {
  return address.name ? `${encodedWords(address.name)} <${address.email}>` : address.email;
}
function base64Lines(content: Uint8Array | string) {
  return Buffer.from(content).toString("base64").match(/.{1,76}/g)?.join(crlf) ?? "";
}
function mimeHeader(name: string, value: string) {
  const content = /[^\x20-\x7e]/.test(value) ? encodedWords(value) : value;
  let line = `${name}:`;
  const lines: string[] = [];
  for (const word of content.split(/\s+/)) {
    if (line.length + word.length + 1 > 78) { lines.push(line); line = ` ${word}`; }
    else line += ` ${word}`;
  }
  lines.push(line);
  return lines.join(crlf);
}

/** RFC 5322 MIME content; Bcc exists only in the separately supplied envelope. */
export function buildMimeMessage(message: CanonicalMessage) {
  const boundary = (label: string) => `envoy_${label}_${requestFingerprint(message.submissionId).slice(0, 32)}`;
  const multipart = (type: string, label: string, parts: string[]) => {
    const separator = boundary(label);
    return `Content-Type: multipart/${type}; boundary="${separator}"${crlf}${crlf}` +
      parts.map(part => `--${separator}${crlf}${part}${crlf}`).join("") + `--${separator}--${crlf}`;
  };
  const textPart = (type: string, value: string) => `Content-Type: ${type}; charset=UTF-8${crlf}Content-Transfer-Encoding: base64${crlf}${crlf}${base64Lines(value)}`;
  const attachmentPart = (attachment: CanonicalMessage["attachments"][number]) => {
    const filename = encodeURIComponent(attachment.fileName).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const segments = filename.match(/(?:%[0-9A-F]{2}|[^%]){1,20}/g) ?? [filename];
    const parameters = segments.length === 1 ? [`filename*=UTF-8''${filename}`] : segments.map((segment, index) => `filename*${index}*=${index === 0 ? "UTF-8''" : ""}${segment}`);
    return [`Content-Type: ${attachment.contentType}`, "Content-Transfer-Encoding: base64",
      `Content-Disposition: ${attachment.disposition};${crlf} ${parameters.join(`;${crlf} `)}`,
      ...(attachment.contentId ? [`Content-ID: <${attachment.contentId}>`] : []), "", base64Lines(attachment.content)].join(crlf);
  };
  const alternatives = [
    ...(message.text === undefined ? [] : [textPart("text/plain", message.text)]),
    ...(message.html === undefined ? [] : [textPart("text/html", message.html)])
  ];
  let body = alternatives.length === 1 ? alternatives[0] : multipart("alternative", "alternative", alternatives);
  const inline = message.attachments.filter(a => a.disposition === "inline");
  if (inline.length) body = multipart("related", "related", [body, ...inline.map(attachmentPart)]);
  const attachments = message.attachments.filter(a => a.disposition === "attachment");
  if (attachments.length) body = multipart("mixed", "mixed", [body, ...attachments.map(attachmentPart)]);
  const headers = [
    `From: ${mimeAddress(message.from)}`,
    ...(message.to.length ? [`To: ${message.to.map(mimeAddress).join(`,${crlf} `)}`] : []),
    ...(message.cc.length ? [`Cc: ${message.cc.map(mimeAddress).join(`,${crlf} `)}`] : []),
    ...(message.replyTo.length ? [`Reply-To: ${message.replyTo.map(mimeAddress).join(`,${crlf} `)}`] : []),
    `Subject: ${encodedWords(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${requestFingerprint(message.submissionId)}@${message.from.email.split("@")[1]}>`,
    "MIME-Version: 1.0",
    ...Object.entries(messageHeaders(message)).map(([name, value]) => mimeHeader(name, value))
  ];
  return new Uint8Array(Buffer.from(headers.join(crlf) + crlf + body, "utf8"));
}

export function requestFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function responseJson(response: Response) {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export async function checkedJson(response: Response): Promise<Record<string, unknown>> {
  const body = await responseJson(response);
  if (!response.ok) {
    const message = safeDiagnostic(body.message ?? body.Message ?? body.error ?? `Provider returned HTTP ${response.status}`);
    const details = `${message} ${JSON.stringify(body.errors ?? "")}`.toLowerCase();
    const invalidRecipient = (response.status === 400 || response.status === 422) && (/recipient/.test(details) || /\bto (email|address)\b/.test(details) || /personalizations.*\.to\./.test(details));
    const providerCode = String(body.code ?? body.name ?? body.ErrorCode ?? `http_${response.status}`);
    if (response.status >= 500 || response.status === 408) throw new CanonicalProviderError(message, "provider", "SUBMISSION_OUTCOME_UNKNOWN", "unknown", false, { providerCode });
    const category = response.status === 401 || response.status === 403 ? "authentication" : response.status === 429 ? "rate_limit" : invalidRecipient ? "invalid_recipient" : response.status >= 500 ? "provider" : "policy";
    throw new CanonicalProviderError(message, category, providerErrorCode(category), "not_accepted", response.status === 429, { providerCode });
  }
  return body;
}

export function accepted(id: unknown, response?: Record<string, unknown>): ProviderSendResult {
  if (typeof id !== "string" || !id) throw new CanonicalProviderError("Provider returned no message identifier", "provider", "SUBMISSION_OUTCOME_UNKNOWN", "unknown", false, { providerCode: "missing_message_id" });
  return { outcome: "accepted", externalMessageId: id, response };
}

export function event(input: Omit<CanonicalEvent, "metadata"> & {
  metadata?: Record<string, unknown>
}): CanonicalEvent {
  return { ...input, metadata: input.metadata ?? {} };
}

export function decodeJson(raw: Uint8Array) {
  return JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
}

export function header(headers: Record<string, string>, name: string) {
  return headers[name.toLowerCase()] ?? headers[name] ?? "";
}

export type MultipartValue = string | { name: string; type: string; bytes: Uint8Array };

export async function parseMultipart(raw: Uint8Array, contentType: string) {
  const form = await new Response(Buffer.from(raw), { headers: { "content-type": contentType } }).formData();
  const result: Record<string, MultipartValue | MultipartValue[]> = {};
  for (const [key, value] of form.entries()) {
    const parsed: MultipartValue = typeof value === "string" ? value : {
      name: value.name,
      type: value.type,
      bytes: new Uint8Array(await value.arrayBuffer())
    };
    const current = result[key];
    result[key] = current ? Array.isArray(current) ? [...current, parsed] : [current, parsed] : parsed
  }
  return result
}


// The submission boundary gets one bounded transport attempt. A lost response
// cannot prove rejection and must never trigger an automatic provider switch.
export async function submitRequest(url: string, options: RequestInit) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new CanonicalProviderError(safeDiagnostic(error instanceof Error ? error.message : "Submission response unavailable"), "network", "SUBMISSION_OUTCOME_UNKNOWN", "unknown", false, { providerCode: "submission_transport_error" });
  }
}

export function stableEventId(payload: unknown) {
  return requestFingerprint(payload);
}

export function eventDate(value: unknown) {
  const date = new Date(typeof value === "number" ? value : String(value ?? ""));
  if (!Number.isFinite(date.getTime())) throw new Error("Provider event is missing a valid occurrence time");
  return date;
}
