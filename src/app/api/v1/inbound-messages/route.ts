import { listInboundMessages } from "@/modules/core/resources/service";
import { decodeCursor } from "@/modules/core/message/service";
import { serviceRoute, apiProblem } from "@/server/service-api";

export const GET = serviceRoute(async (request, identity) => {
  const params=new URL(request.url).searchParams;
  const limit=Number(params.get("limit") ?? 50),raw=params.get("cursor");
  if(raw && !raw.startsWith("inbound.")) return apiProblem("Invalid cursor",400,"Use the browse cursor returned by this resource.",undefined,"INVALID_CURSOR");
  const cursor=raw ? decodeCursor(raw.slice(8)) : null;
  if(!Number.isSafeInteger(limit) || limit<1 || limit>100 || (raw && !cursor)) return apiProblem("Invalid query",400,"limit or cursor is invalid.");
  const page=await listInboundMessages(identity.serviceId,{limit,cursor});
  return Response.json({...page,nextCursor:page.nextCursor ? `inbound.${page.nextCursor}` : null});
});
