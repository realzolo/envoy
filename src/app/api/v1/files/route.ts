import { MAX_FILE_BYTES } from "@/lib/contracts";
import { uploadOutboundFile } from "@/modules/files/service";
import { apiProblem, serviceRoute } from "@/server/service-api";
import { readRequestBytes } from "@/server/request-body";

export const runtime = "nodejs";
export const POST = serviceRoute(async (request, identity) => {
  let fileName: string;
  try { fileName = decodeURIComponent(request.headers.get("x-file-name") ?? ""); }
  catch { return apiProblem("Invalid file name", 422, "X-File-Name must be a URI-encoded UTF-8 file name."); }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "application/octet-stream";
  const result = await uploadOutboundFile(identity.serviceId, fileName, contentType, await readRequestBytes(request, MAX_FILE_BYTES), request.headers.get("x-sending-domain")??"");
  return Response.json(result, { status: 201, headers: { Location: `/api/v1/files/${result.id}` } });
});
