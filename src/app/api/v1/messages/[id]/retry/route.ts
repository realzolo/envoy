import { retryMessageSchema } from "@/lib/contracts";
import { DuplicateRiskError, retryMessage } from "@/modules/core/message/service";
import { authenticateService } from "@/server/auth";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const identity = await authenticateService(request);
  if (!identity) {
    return Response.json({ title: "Unauthorized", status: 401 }, {
      status: 401,
      headers: { "content-type": "application/problem+json" },
    });
  }
  const parsed = retryMessageSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({
      title: "Validation failed",
      status: 422,
      errors: parsed.error.flatten().fieldErrors,
    }, { status: 422, headers: { "content-type": "application/problem+json" } });
  }
  try {
    const result = await retryMessage(
      (await context.params).id,
      identity.serviceId,
      parsed.data.acknowledgeDuplicateRisk,
    );
    if (!result) {
      return Response.json({ title: "Not found", status: 404 }, {
        status: 404,
        headers: { "content-type": "application/problem+json" },
      });
    }
    return Response.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof DuplicateRiskError) {
      return Response.json({ title: "Duplicate-risk acknowledgement required", status: 409, detail: error.message }, {
        status: 409,
        headers: { "content-type": "application/problem+json" },
      });
    }
    throw error;
  }
}
