export type ReaderSourceKind = "INBOUND" | "OUTBOUND";
export type ReaderSource = {
  kind: ReaderSourceKind; id: string; serviceId: string | null; html: string | null; text: string | null;
  attachments: { id: string; contentId: string | null; contentType: string; size: number; sha256: string }[];
};
export type ReaderResource = { id: string; kind: "CID" | "EMBEDDED" | "REMOTE"; source: string; contentType?: string };
export type ReadingSession = { url: string; expiresAt: string; documentRevision: string; channelId: string };
export type ReaderTarget = { kind: ReaderSourceKind; id: string; serviceId: string | null };
export type ReaderResourceTarget = ReaderTarget & { revision: string; resourceId: string };
export type ReaderBytes = { bytes: Uint8Array; contentType: string; sha256: string };
