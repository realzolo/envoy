import { InboundCursorError, listInboundChanges } from "@/modules/inbound/public";
import { apiProblem, serviceRoute } from "@/server/service-api";

export const GET = serviceRoute(async (request,identity) => {
  const params = new URL(request.url).searchParams;
  const limit = Number(params.get("limit") ?? 50);
  const cursor = params.get("cursor");
  if (!Number.isSafeInteger(limit) || limit<1 || limit>100 || (cursor && cursor.length>1024)) return apiProblem("Invalid query",400);
  try { return Response.json(await listInboundChanges(identity.serviceId,limit,cursor)); }
  catch (error) {
    if (error instanceof InboundCursorError) return apiProblem("Inbound cursor unavailable",error.code === "INBOUND_CURSOR_EXPIRED" ? 410 : 400,
      error.code === "INBOUND_CURSOR_EXPIRED" ? "History gap: reconcile retained inbound resources, then resume from resetCursor; deleted content cannot be recovered." : "Invalid service stream cursor.",
      error.resetCursor ? { resetCursor: error.resetCursor, gap: true } : undefined,error.code);
    throw error;
  }
});
