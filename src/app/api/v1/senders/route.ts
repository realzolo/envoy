import { listSenderProfiles } from "@/modules/core/resources/service";
import { serviceRoute } from "@/server/service-api";

export const GET = serviceRoute(async (request, identity) => {
  return Response.json({ data: await listSenderProfiles(identity.productId) });
});
