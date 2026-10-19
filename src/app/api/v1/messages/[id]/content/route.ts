import { ContentConflictError, purgeContent } from "@/modules/identity/public";
import { apiProblem, serviceRoute } from "@/server/service-api";

export const DELETE = serviceRoute(async (_request,identity,context: { params: Promise<{ id: string }> }) => {
  try {
    const result = await purgeContent("message",(await context.params).id,identity.serviceId);
    return result ? Response.json(result,{status:202}) : apiProblem("Not found",404);
  } catch (error) {
    if (error instanceof ContentConflictError) return apiProblem("Content cannot be purged",409,"Active or shared work must be resolved before clearing content.",undefined,error.code);
    throw error;
  }
});
