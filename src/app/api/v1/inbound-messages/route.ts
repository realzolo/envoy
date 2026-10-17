import { listInboundMessages } from "@/modules/core/resources/service";
import { decodeCursor } from "@/modules/core/message/service";
import { serviceRoute, apiProblem } from "@/server/service-api";

export const GET = serviceRoute(async (request, identity) => {
  const params=new URL(request.url).searchParams;
  const limit=Number(params.get("limit") ?? 50),raw=params.get("cursor");
  // Old cursors were based on a provider/author-controlled clock. Never reinterpret them silently.
  if(raw && !raw.startsWith("inb2.")) return apiProblem("Inbound cursor changed",400,"Discard the old time cursor; use /inbound-changes for recovery.",undefined,"INBOUND_LIST_CURSOR_CHANGED");
  const cursor=raw ? decodeCursor(raw.slice(5)) : null;
  if(!Number.isSafeInteger(limit) || limit<1 || limit>100 || (raw && !cursor)) return apiProblem("Invalid query",400,"limit or cursor is invalid.");
  const page=await listInboundMessages(identity.serviceId,{limit,cursor});
  return Response.json({...page,nextCursor:page.nextCursor ? `inb2.${page.nextCursor}` : null});
});
