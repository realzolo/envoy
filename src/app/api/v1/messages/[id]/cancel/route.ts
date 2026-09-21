import { cancelMessage } from "@/modules/core/message/service";
import { authenticateService } from "@/server/auth";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const identity = await authenticateService(request);
  if (!identity) {
    return Response.json({ title: "Unauthorized", status: 401 }, {
      status: 401,
      headers: { "content-type": "application/problem+json" },
    });
  }
  const result = await cancelMessage((await context.params).id, identity.serviceId);
  if (!result) {
    return Response.json({ title: "Not found", status: 404 }, {
      status: 404,
      headers: { "content-type": "application/problem+json" },
    });
  }
  return Response.json(result, { status: 202 });
}
