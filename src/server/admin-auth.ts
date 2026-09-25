import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import { trustedProxyEnabled } from "@/server/network";

const COOKIE_NAME = "envoy_admin_session";
const MAX_AGE = 60 * 60 * 12;

function secret() {
  const value = process.env.ENVOY_SESSION_SECRET;
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error("ENVOY_SESSION_SECRET is required in production");
  }
  return new TextEncoder().encode(value ?? "envoy-local-session-secret-change-before-production");
}

export function sessionCookieIsSecure(request: Request) {
  if (trustedProxyEnabled()) {
    const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
    if (forwardedProtocol) return forwardedProtocol === "https";
  }
  return new URL(request.url).protocol === "https:";
}

export async function createAdminSession(email: string, request: Request) {
  const token = await new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(email)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: sessionCookieIsSecure(request),
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function deleteAdminSession() {
  (await cookies()).delete(COOKIE_NAME);
}

export async function getAdminSession() {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const verified = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    if (verified.payload.role !== "admin" || !verified.payload.sub) return null;
    return { email: verified.payload.sub };
  } catch {
    return null;
  }
}

export function validAdminCredentials(email: string, password: string) {
  const configuredEmail = process.env.ENVOY_ADMIN_EMAIL;
  const configuredPassword = process.env.ENVOY_ADMIN_PASSWORD;
  if (!configuredEmail || !configuredPassword) return false;
  const matches = (providedValue: string, expectedValue: string) => {
    const provided = Buffer.from(providedValue);
    const expected = Buffer.from(expectedValue);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  };
  return matches(email.trim().toLowerCase(), configuredEmail.trim().toLowerCase()) && matches(password, configuredPassword);
}
