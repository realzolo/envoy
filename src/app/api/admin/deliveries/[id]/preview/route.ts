import { getAdminSession } from "@/server/admin-auth";
import { getOutboundPreview, PreviewAccessError } from "@/modules/outbound/public";

export async function GET(_request: Request, context: { params: Promise<{id:string}> }) {
  const headers = { "cache-control": "private, no-store" };
  if (!await getAdminSession()) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  try { return Response.json(await getOutboundPreview((await context.params).id), { headers }); }
  catch (error) {
    if (error instanceof PreviewAccessError) return Response.json({ code: error.code }, { status: error.status, headers });
    throw error;
  }
}
