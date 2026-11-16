import { getAdminSession } from "@/server/admin-auth";
import { readOutboundPreviewResource, PreviewAccessError } from "@/modules/outbound/public";

export async function GET(request: Request, context: { params: Promise<{id:string;resourceId:string}> }) {
  const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" };
  if (!await getAdminSession()) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  const { id, resourceId } = await context.params;
  const params = new URL(request.url).searchParams, revision = params.get("revision") ?? "";
  if (!/^image_[1-9][0-9]{0,2}$/.test(resourceId) || !/^[a-f0-9]{64}$/.test(revision)) return Response.json({ code: "IMAGE_UNAVAILABLE" }, { status: 404, headers });
  try {
    const image = await readOutboundPreviewResource(id, resourceId, revision, request.headers.get("x-envoy-load-remote") === "true");
    return new Response(Buffer.from(image.bytes), { headers: { ...headers, "content-type": image.contentType,
      "content-length": String(image.bytes.byteLength), "x-content-sha256": image.sha256 } });
  } catch (error) {
    if (error instanceof PreviewAccessError) return Response.json({ code: error.code }, { status: error.status, headers });
    throw error;
  }
}
