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

export class CallbackUrlPolicyError extends Error {}

function privateCallbacksAllowed() {
  return process.env.ENVOY_ALLOW_PRIVATE_CALLBACKS === "true";
}

function hostname(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
}

function ipv4Number(value: string) {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((result, part) => result * 256 + part, 0);
}

function inIpv4Range(value: number, start: number, end: number) {
  return value >= start && value <= end;
}

function isPrivateOrReservedIpv4(value: string) {
  const address = ipv4Number(value);
  if (address === null) return true;
  return [
    [0x00000000, 0x00ffffff], // "this" network
    [0x0a000000, 0x0affffff], // RFC 1918
    [0x64400000, 0x647fffff], // carrier-grade NAT
    [0x7f000000, 0x7fffffff], // loopback
    [0xa9fe0000, 0xa9feffff], // link-local / cloud metadata
    [0xac100000, 0xac1fffff], // RFC 1918
    [0xc0000000, 0xc00000ff], // IETF protocol assignments
    [0xc0000200, 0xc00002ff], // documentation
    [0xc0586300, 0xc05863ff], // 6to4 relay anycast
    [0xc0a80000, 0xc0a8ffff], // RFC 1918
    [0xc6120000, 0xc613ffff], // benchmarking
    [0xc6336400, 0xc63364ff], // documentation
    [0xcb007100, 0xcb0071ff], // documentation
    [0xe0000000, 0xffffffff], // multicast and reserved
  ].some(([start, end]) => inIpv4Range(address, start, end));
}

function ipv6Groups(value: string) {
  const dotted = value.lastIndexOf(":");
  let input = value.toLowerCase();
  if (input.includes(".")) {
    const ipv4 = input.slice(dotted + 1);
    const numeric = ipv4Number(ipv4);
    if (numeric === null) return null;
    input = `${input.slice(0, dotted)}:${((numeric >>> 16) & 0xffff).toString(16)}:${(numeric & 0xffff).toString(16)}`;
  }
  const parts = input.split("::");
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  if (left.some(part => !/^[0-9a-f]{1,4}$/.test(part)) || right.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((parts.length === 1 && missing !== 0) || (parts.length === 2 && missing < 1)) return null;
  return [...left, ...Array(missing).fill("0"), ...right].map(part => Number.parseInt(part, 16));
}

function isPrivateOrReservedIpv6(value: string) {
  const groups = ipv6Groups(value);
  if (!groups || groups.length !== 8) return true;
  const isMappedIpv4 = groups.slice(0, 5).every(group => group === 0) && (groups[5] === 0 || groups[5] === 0xffff);
  if (isMappedIpv4) return isPrivateOrReservedIpv4(`${groups[6] >>> 8}.${groups[6] & 0xff}.${groups[7] >>> 8}.${groups[7] & 0xff}`);
  const isWellKnownNat64 = groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every(group => group === 0);
  if (isWellKnownNat64) return isPrivateOrReservedIpv4(`${groups[6] >>> 8}.${groups[6] & 0xff}.${groups[7] >>> 8}.${groups[7] & 0xff}`);
  if (groups.every(group => group === 0)) return true;
  if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((groups[0] & 0xff00) === 0xff00) return true; // multicast
  return (groups[0] === 0x2001 && (groups[1] === 0 || groups[1] === 0x0db8)); // Teredo and documentation
}

export function isPrivateOrReservedAddress(value: string) {
  const family = isIP(value);
  if (family === 4) return isPrivateOrReservedIpv4(value);
  if (family === 6) return isPrivateOrReservedIpv6(value);
  return true;
}

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

export async function postCallback(target: ResolvedCallbackTarget, body: string, headers: Record<string, string>) {
  const request = target.url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<{ status: number; statusText: string; body: string }>((resolve, reject) => {
    const client = request(target.url, {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
      lookup: pinnedLookup(target),
      agent: false,
      timeout: 10_000
    }, response => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        if (length >= 500) return;
        const remaining = 500 - length;
        chunks.push(chunk.subarray(0, remaining));
        length += Math.min(chunk.length, remaining);
      });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        statusText: response.statusMessage ?? "",
        body: Buffer.concat(chunks).toString("utf8")
      }));
      response.on("error", reject);
    });
    client.on("timeout", () => client.destroy(new Error("Callback request timed out")));
    client.on("error", reject);
    client.end(body);
  });
}
