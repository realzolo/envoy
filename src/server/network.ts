import { isIP } from "node:net";

/**
 * Next route handlers do not expose the TCP peer address. A forwarded client
 * address is therefore only meaningful when a reverse proxy is explicitly
 * trusted to replace this header before forwarding the request.
 */
export function trustedProxyEnabled() {
  return process.env.ENVOY_TRUST_PROXY === "true";
}

export function clientIpFromTrustedProxy(request: Request) {
  if (!trustedProxyEnabled()) return undefined;
  const value = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return value && isIP(value) ? value : undefined;
}
