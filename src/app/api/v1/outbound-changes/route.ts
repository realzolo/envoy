import { OutboundCursorError, listOutboundChanges } from "@/modules/outbound/public";
import { apiProblem, serviceRoute } from "@/server/service-api";

export const GET = serviceRoute(async (request, identity) => {
  const params = new URL(request.url).searchParams;
  const limit = Number(params.get("limit") ?? 50);
  const cursor = params.get("cursor");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return apiProblem("Invalid query", 400);
  try {
    if (cursor && cursor.length > 1024) throw new OutboundCursorError("INVALID_OUTBOUND_CURSOR", (await listOutboundChanges(identity.serviceId, 1)).retention.earliestCursor);
    return Response.json(await listOutboundChanges(identity.serviceId, limit, cursor));
  }
  catch (error) {
    if (error instanceof OutboundCursorError) return apiProblem("Outbound cursor unavailable", error.code === "OUTBOUND_CURSOR_EXPIRED" ? 410 : 400,
      error.code === "OUTBOUND_CURSOR_EXPIRED" ? "History gap: reconcile retained outbound messages, then resume from resetCursor." : "Invalid Service stream cursor.",
      { resetCursor: error.resetCursor, ...(error.code === "OUTBOUND_CURSOR_EXPIRED" ? { gap: true } : {}) }, error.code);
    throw error;
  }
});
