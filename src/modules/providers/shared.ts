import { createHash } from "node:crypto";
import { type CanonicalEvent, CanonicalProviderError, type ProviderSendResult } from "./contracts";

export function requestFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function responseJson(response: Response) {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export async function checkedJson(response: Response): Promise<Record<string, unknown>> {
  const body = await responseJson(response);
  if (!response.ok) {
    const message = String(body.message ?? body.error ?? `Provider returned HTTP ${response.status}`);
    const details = `${message} ${JSON.stringify(body.errors ?? "")}`.toLowerCase();
    const invalidRecipient = (response.status === 400 || response.status === 422) && (/recipient/.test(details) || /\bto (email|address)\b/.test(details) || /personalizations.*\.to\./.test(details));
    const category = response.status === 401 || response.status === 403 ? "authentication" : response.status === 429 ? "rate_limit" : invalidRecipient ? "invalid_recipient" : response.status >= 500 ? "provider" : "policy";
    throw new CanonicalProviderError(message, category, `http_${response.status}`, "not_accepted", response.status === 429 || response.status >= 500);
  }
  return body;
}

export function accepted(id: unknown, response?: Record<string, unknown>): ProviderSendResult {
  if (typeof id !== "string" || !id) throw new CanonicalProviderError("Provider returned no message identifier", "provider", "missing_message_id", "unknown", false);
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
