import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

type CallbackAddress = { address: string; family: 4 | 6 };

export type ResolvedCallbackTarget = {
  url: URL;
  addresses: CallbackAddress[];
};

type HostResolver = (hostname: string) => Promise<CallbackAddress[]>;

import { CallbackUrlPolicyError } from "../domain/policy";

function privateCallbacksAllowed() {
  return process.env.ENVOY_ALLOW_PRIVATE_CALLBACKS === "true";
}

function hostname(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
}

export { isPrivateOrReservedAddress } from "@/platform/network-address";
import { isPrivateOrReservedAddress } from "@/platform/network-address";

async function resolveHost(host: string): Promise<CallbackAddress[]> {
  const addresses = await dnsLookup(host, { all: true, verbatim: true });
  return addresses.flatMap(address => address.family === 4 || address.family === 6 ? [{
    address: address.address,
    family: address.family
  }] : []);
}

function parseCallbackUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CallbackUrlPolicyError("Callback URL must be a valid absolute URL");
  }
  if (url.username || url.password || url.hash) throw new CallbackUrlPolicyError("Callback URL must not include credentials or a fragment");
  if (url.protocol !== "https:" && !(privateCallbacksAllowed() && url.protocol === "http:")) {
    throw new CallbackUrlPolicyError("Callback URL must use HTTPS");
  }
  return url;
}

export async function resolveCallbackTarget(value: string, resolver: HostResolver = resolveHost): Promise<ResolvedCallbackTarget> {
  const url = parseCallbackUrl(value);
  const host = hostname(url);
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) as 4 | 6 }] : await resolver(host);
  if (!addresses.length || addresses.some(address => !isIP(address.address))) throw new CallbackUrlPolicyError("Callback hostname did not resolve to an IP address");
  const hasPrivateAddress = addresses.some(address => isPrivateOrReservedAddress(address.address));
  if (hasPrivateAddress && !privateCallbacksAllowed()) throw new CallbackUrlPolicyError("Callback URL must not resolve to a private or reserved address");
  if (url.protocol === "http:" && !addresses.every(address => isPrivateOrReservedAddress(address.address))) {
    throw new CallbackUrlPolicyError("HTTP callback URLs are allowed only for private addresses");
  }
  return { url, addresses };
}

function pinnedLookup(target: ResolvedCallbackTarget): LookupFunction {
  return ((_: string, options: { all?: boolean; family?: number }, callback: (error: Error | null, address: string | CallbackAddress[], family?: number) => void) => {
    const addresses = target.addresses.filter(item => !options.family || item.family === options.family);
    const selected = addresses.length ? addresses : target.addresses;
    if (options.all) callback(null, selected);
    else callback(null, selected[0].address, selected[0].family);
  }) as LookupFunction;
}

export const CALLBACK_TIMEOUT_MS = 10_000;
type CallbackResponse = { status: number; statusText: string; body: string };
type DeliveryOptions = { signal?: AbortSignal; beforeSend?: () => Promise<void> };

export async function postCallback(target: ResolvedCallbackTarget, body: string, headers: Record<string, string>, options: DeliveryOptions = {}) {
  const request = target.url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<CallbackResponse>((resolve, reject) => {
    let settled = false;
    const client = request(target.url, {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
      lookup: pinnedLookup(target), agent: false, signal: options.signal,
    }, response => {
      const status = response.statusCode ?? 0, statusText = response.statusMessage ?? "";
      const chunks: Buffer[] = [];
      let length = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({ status, statusText, body: Buffer.concat(chunks).toString("utf8") });
        response.destroy();
      };
      // HTTP success acknowledges receipt; the target body has no protocol meaning.
      if (status >= 200 && status < 300) { finish(); return; }
      response.on("data", (chunk: Buffer) => {
        const part = chunk.subarray(0, 500 - length);
        chunks.push(part); length += part.length;
        if (length >= 500) finish();
      });
      response.on("end", finish);
      response.on("error", error => { if (!settled) { settled = true; reject(error); } });
    });
    client.on("error", error => { if (!settled) { settled = true; reject(error); } });
    client.once("socket", socket => {
      socket.once(target.url.protocol === "https:" ? "secureConnect" : "connect", () => {
        void (async () => {
          options.signal?.throwIfAborted();
          await options.beforeSend?.();
          options.signal?.throwIfAborted();
          client.end(body);
        })().catch(error => client.destroy(error instanceof Error ? error : new Error("Callback authorization failed")));
      });
    });
  });
}

/** One execution budget covers resolution, connection, authorization and response. */
export async function sendCallback(url: string, body: string, headers: Record<string, string>, beforeSend: () => Promise<void>,
  options: { timeoutMs?: number; resolver?: HostResolver } = {}) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Callback execution deadline exceeded");
      controller.abort(error); reject(error);
    }, options.timeoutMs ?? CALLBACK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([expired, (async () => {
      const target = await resolveCallbackTarget(url, options.resolver);
      controller.signal.throwIfAborted();
      return postCallback(target, body, headers, { signal: controller.signal, beforeSend });
    })()]);
  } finally { clearTimeout(timer!); }
}
