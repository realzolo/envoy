import type { ReaderBytes, ReaderResourceTarget, ReaderSource, ReaderTarget, ReadingSession } from "../contracts";
import { compileReader, readerSourceFingerprint } from "../domain/document";
import type { ReaderCacheEntry, ReaderCacheIdentity, ReaderCacheImage } from "../cache-contracts";

export class ReaderError extends Error {
  constructor(readonly status: 404 | 409 | 410 | 503, readonly code: string) {
    super(code);
  }
}

export type ReaderGrant = ReaderTarget & { revision: string; expiresAt: number; channelId: string };

export interface ReaderCachePort {
  get(key: ReaderCacheIdentity, includeBytes?: boolean): Promise<ReaderCacheEntry | null>;

  enqueue(key: ReaderCacheIdentity, serviceId: string | null): Promise<void>;

  claim(key: ReaderCacheIdentity): Promise<{ token: string; serviceId: string | null } | null>;

  store(key: ReaderCacheIdentity, token: string, image: ReaderCacheImage): Promise<boolean>;

  fail(key: ReaderCacheIdentity, token: string, reasonCode: string, retryable: boolean): Promise<void>;

  retryFailed(target: Omit<ReaderCacheIdentity, "resourceId">, serviceId: string | null, operationId: string): Promise<number>;
}

export interface ReaderDependencies {
  cache: ReaderCachePort;

  readSource(target: ReaderTarget): Promise<ReaderSource | null>;

  digest(bytes: Uint8Array): string;

  seal(grant: ReaderGrant): string;

  open(token: string): ReaderGrant;

  randomId(): string;

  now(): number;

  readAttachment(kind: "inbound" | "outbound", id: string, serviceId: string | undefined, parentId: string | undefined): Promise<{
    bytes: Uint8Array
  } | null>;

  fetchImage(url: string, authorize: () => Promise<void>): Promise<Uint8Array>;
}

export const READING_SESSION_TTL_MS = 120_000;
const MAX_CONCURRENT_READER_PREPARATIONS = 3;
export const MAX_READER_IMAGE_BYTES = 20_000_000;

export function createReaderService(deps: ReaderDependencies) {
  let activePreparations = 0;
  const revision = (source: ReaderSource) => deps.digest(Buffer.from(readerSourceFingerprint(source)));

  async function source(target: ReaderTarget, expected?: string) {
    let record: ReaderSource | null;
    try {
      record = await deps.readSource(target);
    } catch {
      throw new ReaderError(409, "READING_SOURCE_PENDING");
    }
    if (!record || expected && revision(record) !== expected) throw new ReaderError(404, "READING_UNAVAILABLE");
    return record;
  }

  function grant(token: string) {
    let value: ReaderGrant;
    try {
      value = deps.open(token);
    } catch {
      throw new ReaderError(404, "READING_UNAVAILABLE");
    }
    if (!value || !["INBOUND", "OUTBOUND"].includes(value.kind) || typeof value.id !== "string" || typeof value.revision !== "string" || typeof value.channelId !== "string" || typeof value.expiresAt !== "number" || !(value.serviceId === null || typeof value.serviceId === "string")) throw new ReaderError(404, "READING_UNAVAILABLE");
    if (value.expiresAt <= deps.now()) throw new ReaderError(410, "READING_SESSION_EXPIRED");
    return value;
  }

  async function authorize(token: string) {
    const value = grant(token);
    return { grant: value, source: await source(value, value.revision) };
  }

  async function fetchResource(target: ReaderResourceTarget): Promise<ReaderBytes> {
    const record = await source(target, target.revision),
      resource = compileReader(record).resources.find(item => item.id === target.resourceId);
    if (!resource) throw new ReaderError(404, "READING_RESOURCE_UNAVAILABLE");
    const check = async () => {
      await source(target, target.revision);
    };
    let bytes: Uint8Array;
    if (resource.kind === "CID") {
      const cid = (value: string | null) => value?.trim().replace(/^<|>$/g, "");
      const matches = record.attachments.filter(item => cid(item.contentId) === resource.source);
      if (matches.length !== 1) throw new ReaderError(404, "READING_RESOURCE_UNAVAILABLE");
      const attachment = matches[0];
      const result = await deps.readAttachment(record.kind === "INBOUND" ? "inbound" : "outbound", attachment.id, record.kind === "OUTBOUND" ? record.serviceId ?? undefined : target.serviceId ?? undefined, record.kind === "INBOUND" ? record.id : undefined);
      if (!result || result.bytes.byteLength !== attachment.size || deps.digest(result.bytes) !== attachment.sha256) throw new ReaderError(409, "READING_RESOURCE_UNAVAILABLE");
      bytes = result.bytes;
    } else if (resource.kind === "EMBEDDED") {
      const match = /^data:(image\/[a-z0-9.+-]+)((?:;[^,]*)?),([\s\S]*)$/i.exec(resource.source);
      if (!match) throw new ReaderError(409, "READING_RESOURCE_UNAVAILABLE");
      try {
        bytes = /;base64(?:;|$)/i.test(match[2]) ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
      } catch {
        throw new ReaderError(409, "READING_RESOURCE_UNAVAILABLE");
      }
    } else bytes = await deps.fetchImage(resource.source, check);
    if (!bytes.byteLength || bytes.byteLength > MAX_READER_IMAGE_BYTES) throw new ReaderError(409, "READING_RESOURCE_LIMIT");
    const contentType = imageType(bytes);
    if (!contentType) throw new ReaderError(409, "READING_RESOURCE_UNSUPPORTED");
    await check();
    return { bytes, contentType, sha256: deps.digest(bytes) };
  }

  async function prepareResource(target: ReaderResourceTarget): Promise<ReaderBytes> {
    await source(target, target.revision);
    const prior = await deps.cache.get(target);
    if (prior?.state === "READY" && prior.bytes && prior.contentType && prior.sha256) {
      if (deps.digest(prior.bytes) !== prior.sha256) throw new ReaderError(409, "READING_RESOURCE_UNAVAILABLE");
      await source(target, target.revision);
      return { bytes: prior.bytes, contentType: prior.contentType, sha256: prior.sha256 };
    }
    if (prior?.state === "UNAVAILABLE") throw new ReaderError(409, prior.reasonCode ?? "READING_RESOURCE_UNAVAILABLE");
    await deps.cache.enqueue(target, target.serviceId);
    if (activePreparations >= MAX_CONCURRENT_READER_PREPARATIONS) throw new ReaderError(503, "READING_BUSY");
    activePreparations++;
    let claim: { token: string; serviceId: string | null } | null = null;
    try {
      claim = await deps.cache.claim(target);
      if (!claim) throw new ReaderError(409, "READING_SOURCE_PENDING");
      const image = await fetchResource(target);
      await source(target, target.revision);
      if (!await deps.cache.store(target, claim.token, image)) throw new ReaderError(409, "READING_RESOURCE_LIMIT");
      return image;
    } catch (error) {
      const reason = error instanceof ReaderError ? error.code : "READING_FETCH_FAILED";
      const retryable = !(error instanceof ReaderError) || error.code === "READING_SOURCE_PENDING";
      if (claim) await deps.cache.fail(target, claim.token, reason, retryable);
      if (error instanceof ReaderError) throw error;
      throw new ReaderError(409, reason);
    } finally {
      activePreparations--;
    }
  }

  return {
    async issue(target: ReaderTarget, origin: string): Promise<ReadingSession> {
      const record = await source(target), documentRevision = revision(record), channelId = deps.randomId(),
        expiresAt = deps.now() + READING_SESSION_TTL_MS;
      await Promise.all(compileReader(record).resources.map(resource => deps.cache.enqueue({
        ...target,
        revision: documentRevision,
        resourceId: resource.id
      }, target.serviceId)));
      const token = deps.seal({ ...target, revision: documentRevision, expiresAt, channelId });
      return {
        url: `${origin}/mail-reader/${token}`,
        expiresAt: new Date(expiresAt).toISOString(),
        documentRevision,
        channelId
      };
    },
    authorize, grant, prepareResource,
    async retry(token: string, operationId: string) {
      const current = await authorize(token);
      try {
        await deps.cache.retryFailed(current.grant, current.grant.serviceId, operationId);
      } catch {
        throw new ReaderError(409, "READING_RETRY_CONFLICT");
      }
      return this.status(token);
    },
    async document(token: string) {
      const current = await authorize(token);
      return { ...current, document: compileReader(current.source) };
    },
    async readResource(token: string, resourceId: string) {
      const value = grant(token);
      const image = await prepareResource({ ...value, resourceId });
      await authorize(token);
      return image;
    },
    async status(token: string) {
      const current = await authorize(token);
      const resources = await Promise.all(compileReader(current.source).resources.map(async item => {
        const entry = await deps.cache.get({ ...current.grant, resourceId: item.id }, false);
        return {
          id: item.id,
          state: entry?.state ?? "PENDING",
          reasonCode: entry?.reasonCode ?? null,
          sha256: entry?.sha256 ?? null,
          updatedAt: entry?.updatedAt ?? null,
          nextRetryAt: entry?.nextAttemptAt ?? null
        };
      }));
      const total = resources.length, ready = resources.filter(item => item.state === "READY").length,
        failed = resources.filter(item => item.state === "UNAVAILABLE").length, active = total - ready - failed;
      const delays = resources.filter(item => !["READY", "UNAVAILABLE"].includes(item.state)).map(item => item.state === "RETRY_WAIT" && item.nextRetryAt ? Date.parse(item.nextRetryAt) - deps.now() : 5000);
      const nextCheckAt = active ? new Date(deps.now() + Math.max(1000, Math.min(30_000, ...delays))).toISOString() : null;
      return {
        documentRevision: current.grant.revision,
        expiresAt: new Date(current.grant.expiresAt).toISOString(),
        total,
        ready,
        active,
        failed,
        nextCheckAt,
        statusRevision: deps.digest(Buffer.from(JSON.stringify(resources))),
        resources
      };
    },
  };
}

/** Byte identification supports native browser images, including animated GIF, AVIF and SVG-as-image. */
export function imageType(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString("ascii", 0, 6))) return "image/gif";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 16 && b.toString("ascii", 4, 8) === "ftyp" && /avif|avis/.test(b.toString("ascii", 8, Math.min(b.length, 80)))) return "image/avif";
  const start = b.subarray(0, 4096).toString("utf8").replace(/^\uFEFF/, "").replace(/<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/gi, "").trim();
  if (/^<svg(?:\s|\/?>)/i.test(start)) return "image/svg+xml";
  return null;
}
