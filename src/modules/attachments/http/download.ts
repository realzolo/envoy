import { readAttachment } from "../infrastructure/services";

/** HTTP headers and response serialization belong at the transport boundary. */
export async function downloadAttachment(kind: "outbound" | "inbound", id: string, serviceId?: string, parentId?: string) {
  const file = await readAttachment(kind, id, serviceId, parentId);
  if (!file) return null;
  const name = file.fileName.replace(/[\\"\r\n\x00-\x1f]/g, "_");
  return new Response(Buffer.from(file.bytes), { headers: {
    "content-type": "application/octet-stream",
    "content-length": String(file.bytes.byteLength),
    "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "content-security-policy": "sandbox",
  } });
}
