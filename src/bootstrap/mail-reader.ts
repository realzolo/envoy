import { createHash, randomBytes } from "node:crypto";
import { createReaderService, type ReaderGrant } from "@/modules/mail-reader/application/service";
import { readInboundReaderSource } from "@/modules/inbound/sources";
import { readOutboundReaderSource } from "@/modules/outbound/sources";
import { readAttachment } from "@/modules/attachments/public";
import { openSecret, sealSecret } from "@/platform/crypto/envelope";
import { fetchDocumentImage } from "@/platform/mail-media";
import { readerCache } from "@/modules/mail-reader/infrastructure/cache.repository";

export const mailReader = createReaderService({
  cache: readerCache,
  readSource: target => target.kind === "INBOUND" ? readInboundReaderSource(target.id, target.serviceId) : readOutboundReaderSource(target.id, target.serviceId),
  digest: bytes => createHash("sha256").update(bytes).digest("hex"),
  seal: grant => Buffer.from(JSON.stringify(sealSecret(grant, "mail-reader-capability", 2))).toString("base64url"),
  open: token => {
    if (token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid reading capability");
    return openSecret<ReaderGrant>(JSON.parse(Buffer.from(token, "base64url").toString("utf8")), "mail-reader-capability", 2);
  },
  randomId: () => randomBytes(16).toString("hex"),
  now: Date.now,
  readAttachment,
  fetchImage: (url, authorize) => fetchDocumentImage(url, authorize, undefined, 10_000, {
    maximumBytes: 20_000_000,
    accept: "image/avif,image/svg+xml,image/*;q=0.9",
    allowCompression: true
  }),
});
