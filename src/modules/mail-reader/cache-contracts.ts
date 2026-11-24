export type ReaderCacheIdentity = { kind: "INBOUND" | "OUTBOUND"; id: string; revision: string; resourceId: string };
export type ReaderCacheState = "PENDING" | "RUNNING" | "READY" | "RETRY_WAIT" | "UNAVAILABLE";
export type ReaderCacheEntry = {
  state: ReaderCacheState;
  reasonCode: string | null;
  contentType: string | null;
  size: number | null;
  sha256: string | null;
  bytes?: Uint8Array;
  nextAttemptAt: string;
  updatedAt: string
};
export type ReaderCacheJob = ReaderCacheIdentity & { serviceId: string | null; updatedAt: string };
export type ReaderCacheImage = { bytes: Uint8Array; contentType: string; sha256: string };
