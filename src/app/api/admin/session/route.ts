import { createAdminSession, deleteAdminSession, getAdminSession, validAdminCredentials } from "@/server/admin-auth";

export async function GET() {
  const session = await getAdminSession();
  return session ? Response.json(session) : Response.json({ title: "Unauthorized" }, { status: 401 });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { email?: string; password?: string };
  if (!body.email || !body.password || !validAdminCredentials(body.email, body.password)) {
    return Response.json({ title: "Unauthorized" }, { status: 401 });
  }
  await createAdminSession(body.email, request);
  return Response.json({ email: body.email });
}

export async function DELETE() {
  await deleteAdminSession();
  return new Response(null, { status: 204 });
}
