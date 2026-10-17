import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface ObjectStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;

  get(key: string): Promise<Uint8Array>;

  delete(key: string): Promise<void>
}

export function objectStorageKey(key: string, configuredPrefix = process.env.OBJECT_STORAGE_PREFIX) {
  const logicalKey = key.replace(/^\/+/, "");
  const prefix = (configuredPrefix?.trim() || "envoy").replace(/^\/+|\/+$/g, "");
  const segments = [...prefix.split("/"), ...logicalKey.split("/")];
  if (!logicalKey || segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid object key")
  }
  return `${prefix}/${logicalKey}`
}

class LocalObjectStore implements ObjectStore {
  private root = resolve(join(process.cwd(), "var", "objects"));

  async put(key: string, data: Uint8Array) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data)
  }

  async get(key: string) {
    return new Uint8Array(await readFile(this.path(key)))
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true })
  }

  private path(key: string) {
    const target = resolve(join(this.root, objectStorageKey(key)));
    if (!target.startsWith(`${this.root}/`)) throw new Error("Invalid object key");
    return target
  }
}

class S3ObjectStore implements ObjectStore {
  private client = new S3Client({
    region: process.env.OBJECT_STORAGE_REGION,
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
    forcePathStyle: Boolean(process.env.OBJECT_STORAGE_ENDPOINT),
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000, throwOnRequestTimeout: true },
    credentials: process.env.OBJECT_STORE_ACCESS_KEY_ID && process.env.OBJECT_STORE_SECRET_ACCESS_KEY ? {
      accessKeyId: process.env.OBJECT_STORE_ACCESS_KEY_ID,
      secretAccessKey: process.env.OBJECT_STORE_SECRET_ACCESS_KEY
    } : undefined
  });
  private bucket = process.env.OBJECT_STORAGE_BUCKET ?? "";

  constructor() {
    if (!this.bucket) throw new Error("OBJECT_STORAGE_BUCKET is required for the S3 object store");
    if (Boolean(process.env.OBJECT_STORE_ACCESS_KEY_ID) !== Boolean(process.env.OBJECT_STORE_SECRET_ACCESS_KEY)) {
      throw new Error("Object store access key and secret must be configured together")
    }
    if (process.env.OBJECT_STORE_SERVER_SIDE_ENCRYPTION && !["AES256", "aws:kms"].includes(process.env.OBJECT_STORE_SERVER_SIDE_ENCRYPTION)) {
      throw new Error("Unsupported object store server-side encryption setting")
    }
  }

  async put(key: string, data: Uint8Array, contentType: string) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectStorageKey(key),
      Body: data,
      ContentType: contentType,
      ServerSideEncryption: process.env.OBJECT_STORE_SERVER_SIDE_ENCRYPTION as "AES256" | "aws:kms" | undefined
    }))
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectStorageKey(key) }))
  }

  async get(key: string) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectStorageKey(key) }));
    if (!result.Body) throw new Error("Object body is empty");
    return result.Body.transformToByteArray()
  }
}

let instance: ObjectStore | undefined;

export function objectStore() {
  instance ??= process.env.OBJECT_STORAGE_DRIVER === "s3" ? new S3ObjectStore() : new LocalObjectStore();
  return instance
}
