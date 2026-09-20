import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const COOKIE_NAME = "envoy_admin_session";
const MAX_AGE = 60 * 60 * 12;

function secret() {
  const value = process.env.ENVOY_SESSION_SECRET;
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error("ENVOY_SESSION_SECRET is required in production");
  }
  return new TextEncoder().encode(value ?? "envoy-local-session-secret-change-before-production");
}

export async function createAdminSession(email: string) {
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
    secure: process.env.NODE_ENV === "production",
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
  return email === (process.env.ENVOY_ADMIN_EMAIL ?? "admin@envoy.local")
    && password === (process.env.ENVOY_ADMIN_PASSWORD ?? "envoy");
}

