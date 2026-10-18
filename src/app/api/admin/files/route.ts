import { MAX_FILE_BYTES } from "@/lib/contracts";
import { getAdminSession } from "@/server/admin-auth";
import { query } from "@/server/database";
import { BodyTooLargeError, readRequestBytes } from "@/server/request-body";
import { FileValidationError, uploadOutboundFile } from "@/modules/files/service";

export async function POST(request: Request) {
  const session = await getAdminSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const serviceId = new URL(request.url).searchParams.get("serviceId");
    const service = await query("SELECT s.id FROM services s JOIN products p ON p.id=s.product_id WHERE s.id=$1 AND p.status='active'", [serviceId]);
    if (!service.rows[0]) return Response.json({ error: "Select an active service" }, { status: 422 });
    const fileName = decodeURIComponent(request.headers.get("x-file-name") ?? "");
    const contentType = request.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
    const bytes = await readRequestBytes(request, MAX_FILE_BYTES);
    const result = await uploadOutboundFile(serviceId!, fileName, contentType, bytes, request.headers.get("x-sending-domain")??"");
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return Response.json({ error: error.message }, { status: 413 });
    if (error instanceof FileValidationError || error instanceof URIError) return Response.json({ error: error.message }, { status: 422 });
    console.error("Admin file upload failed", error);
    return Response.json({ error: "File upload failed" }, { status: 503 });
  }
}
