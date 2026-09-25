import { createHash } from "node:crypto";
import { createAdminSession, deleteAdminSession, getAdminSession, validAdminCredentials } from "@/server/admin-auth";
import { clientIpFromTrustedProxy } from "@/server/network";
import { enforceScopedRateLimit } from "@/server/redis";

const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_EMAIL_LIMIT = 10;
const LOGIN_IP_LIMIT = 30;

function rateLimitId(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

export async function GET() {
  const session = await getAdminSession();
  return session ? Response.json(session) : Response.json({ title: "Unauthorized" }, { status: 401 });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { email?: string; password?: string };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return Response.json({ title: "Unauthorized" }, { status: 401 });
  }
  if (!validAdminCredentials(email, password)) {
    const limits = [enforceScopedRateLimit("admin-login-email", rateLimitId(email), LOGIN_EMAIL_LIMIT, LOGIN_WINDOW_SECONDS)];
    const clientIp = clientIpFromTrustedProxy(request);
    if (clientIp) limits.push(enforceScopedRateLimit("admin-login-ip", rateLimitId(clientIp), LOGIN_IP_LIMIT, LOGIN_WINDOW_SECONDS));
    try {
      if (!(await Promise.all(limits)).every(Boolean)) {
        return Response.json({ title: "Too many sign-in attempts" }, {
          status: 429,
          headers: { "Retry-After": String(LOGIN_WINDOW_SECONDS) }
        });
      }
    } catch {
      return Response.json({ title: "Sign-in protection is unavailable" }, { status: 503 });
    }
    return Response.json({ title: "Unauthorized" }, { status: 401 });
  }
  await createAdminSession(email, request);
  return Response.json({ email });
}

export async function DELETE() {
  await deleteAdminSession();
  return new Response(null, { status: 204 });
}
