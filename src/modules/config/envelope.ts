import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

type CipherParts = { iv: Buffer; tag: Buffer; ciphertext: Buffer };

function pack(parts: CipherParts) {
  return `${parts.iv.toString("base64url")}.${parts.tag.toString("base64url")}.${parts.ciphertext.toString("base64url")}`
}

function unpack(value: string): CipherParts {
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted value");
  return {
    iv: Buffer.from(parts[0], "base64url"),
    tag: Buffer.from(parts[1], "base64url"),
    ciphertext: Buffer.from(parts[2], "base64url")
  }
}

function encrypt(key: Buffer, value: Buffer, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return pack({ iv, tag: cipher.getAuthTag(), ciphertext })
}

function decrypt(key: Buffer, value: string, aad: string) {
  const parts = unpack(value);
  const decipher = createDecipheriv("aes-256-gcm", key, parts.iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(parts.tag);
  return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()])
}

function decodeRootKey(encoded: string) {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("An Envoy KEK must decode to 32 bytes");
  return key
}

function currentKeyVersion() {
  return process.env.ENVOY_KEK_VERSION ?? "local-1"
}

function rootKey(version: string) {
  const current = process.env.ENVOY_KEK_BASE64;
  if (version === currentKeyVersion()) {
    if (current) return decodeRootKey(current);
    if (process.env.NODE_ENV === "production") throw new Error("ENVOY_KEK_BASE64 is required in production");
    return createHash("sha256").update("envoy-development-root-key").digest()
  }
  let keyring: Record<string, string> = {};
  try {
    keyring = JSON.parse(process.env.ENVOY_KEK_KEYRING_JSON ?? "{}") as Record<string, string>
  } catch {
    throw new Error("ENVOY_KEK_KEYRING_JSON must be valid JSON")
  }
  const encoded = keyring[version];
  if (!encoded) throw new Error(`No KEK is configured for version ${version}`);
  return decodeRootKey(encoded)
}

export type Envelope = { secretCiphertext: string; encryptedDek: string; keyVersion: string };

export function sealSecret(value: unknown, resourceId: string, version: number): Envelope {
  const aad = `${resourceId}:${version}`;
  const dek = randomBytes(32);
  const keyVersion = currentKeyVersion();
  return {
    secretCiphertext: encrypt(dek, Buffer.from(JSON.stringify(value)), aad),
    encryptedDek: encrypt(rootKey(keyVersion), dek, aad),
    keyVersion
  }
}

export function openSecret<T>(envelope: Envelope, resourceId: string, version: number): T {
  const aad = `${resourceId}:${version}`;
  const dek = decrypt(rootKey(envelope.keyVersion), envelope.encryptedDek, aad);
  return JSON.parse(decrypt(dek, envelope.secretCiphertext, aad).toString("utf8")) as T
}
