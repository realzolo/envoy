import { bitmapInfo } from "@/lib/mail-bitmap";
import { MAX_IMAGE_BYTES, projectDocument } from "@/lib/mail-document";
import { MAX_PREVIEW_IMAGE_CONCURRENCY } from "@/lib/mail-image-policy";
import type { MailPreview } from "@/lib/mail-document-contracts";
import type { StoredAttachment } from "../contracts";

export type PreviewRecord = {
  messageId: string; serviceId: string; html: string;
  attachments: Pick<StoredAttachment, "fileId" | "contentId" | "disposition" | "size" | "sha256">[];
};
export interface PreviewDependencies {
  read(deliveryId: string): Promise<PreviewRecord | null>;
  digest(bytes: Uint8Array): string;
  readAttachment(fileId: string, serviceId: string): Promise<{ bytes: Uint8Array } | null>;
  fetchImage(url: string, authorize: () => Promise<void>): Promise<Uint8Array>;
  scan(bytes: Uint8Array): Promise<{ status: string; sha256: string }>;
  scanPolicy(): { version: string; mode: "require_clean" | "integrity_only" };
}

export class PreviewAccessError extends Error {
  constructor(readonly status: 404 | 409, readonly code: string) { super(code); }
}

export function createOutboundPreviewService(deps: PreviewDependencies) {
  let activeResources = 0;
  const revisionOf = (record: PreviewRecord) => deps.digest(Buffer.from(JSON.stringify(record)));
  const read = async (deliveryId: string, expectedRevision?: string) => {
    const record = await deps.read(deliveryId);
    if (!record) throw new PreviewAccessError(404, "PREVIEW_UNAVAILABLE");
    const revision = revisionOf(record);
    if (expectedRevision !== undefined && revision !== expectedRevision) throw new PreviewAccessError(404, "PREVIEW_UNAVAILABLE");
    return { record, revision };
  };
  const project = (record: PreviewRecord) => {
    let index = 0;
    return projectDocument({ html: record.html, text: null, textProvenance: "UNAVAILABLE",
      attachments: record.attachments.filter(file => file.disposition === "inline").map(file => ({ id: file.fileId, contentId: file.contentId })),
    }, { revision: "1", digest: null, id: () => `image_${++index}` });
  };
  return {
    async getPreview(deliveryId: string): Promise<MailPreview> {
      const { record, revision } = await read(deliveryId);
      const projection = project(record);
      await read(deliveryId, revision);
      return { html: projection.html ?? "", revision, resources: projection.resources.map(resource => ({
        id: resource.id, kind: resource.kind,
        available: resource.kind === "REMOTE" ? !!resource.source?.url : resource.downloadEligible,
      })) };
    },
    async readResource(deliveryId: string, resourceId: string, revision: string, allowRemote: boolean) {
      const { record } = await read(deliveryId, revision);
      const resource = project(record).resources.find(item => item.id === resourceId);
      if (!resource || (resource.kind === "REMOTE" && !allowRemote)) throw new PreviewAccessError(404, "IMAGE_UNAVAILABLE");
      if (activeResources >= MAX_PREVIEW_IMAGE_CONCURRENCY) throw new PreviewAccessError(409, "IMAGE_BUSY");
      activeResources++;
      const authorize = async () => { await read(deliveryId, revision); };
      try {
        const policy = deps.scanPolicy();
        let bytes: Uint8Array;
        if (resource.kind === "CID") {
          const snapshot = record.attachments.find(file => file.fileId === resource.attachmentId);
          if (!snapshot || snapshot.size > MAX_IMAGE_BYTES) throw new PreviewAccessError(409, "IMAGE_UNAVAILABLE");
          const attachment = await deps.readAttachment(snapshot.fileId, record.serviceId);
          if (!attachment || attachment.bytes.byteLength !== snapshot.size || deps.digest(attachment.bytes) !== snapshot.sha256) throw new PreviewAccessError(409, "IMAGE_UNAVAILABLE");
          bytes = attachment.bytes;
        } else {
          const source = resource.source;
          if (source?.base64) bytes = Buffer.from(source.base64, "base64");
          else if (source?.url) bytes = await deps.fetchImage(source.url, authorize);
          else throw new PreviewAccessError(409, "IMAGE_UNAVAILABLE");
        }
        const info = bitmapInfo(bytes), sha256 = deps.digest(bytes);
        if (resource.kind !== "CID") {
          const scan = await deps.scan(bytes);
          if (scan.status !== (policy.mode === "require_clean" ? "clean" : "verified") || scan.sha256 !== sha256 || deps.scanPolicy().version !== policy.version || deps.scanPolicy().mode !== policy.mode) throw new PreviewAccessError(409, "IMAGE_UNAVAILABLE");
        }
        if (deps.scanPolicy().version !== policy.version || deps.scanPolicy().mode !== policy.mode) throw new PreviewAccessError(409, "IMAGE_UNAVAILABLE");
        await authorize();
        return { bytes, contentType: info.contentType, sha256 };
      } catch (error) {
        if (error instanceof PreviewAccessError) throw error;
        throw new PreviewAccessError(409, "IMAGE_UNAVAILABLE");
      } finally { activeResources--; }
    },
  };
}
