import { isIP } from "node:net";

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

