import { mkdir, writeFile, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface ObjectStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;

  get(key: string, maximum?: number): Promise<Uint8Array>;

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


async function boundedBytes(stream: AsyncIterable<Uint8Array> & {destroy?:()=>void},maximum=30_000_000) {
  const chunks:Buffer[]=[];let length=0;
  try {
    for await (const chunk of stream) {
      length+=chunk.byteLength;
      if(length>maximum) throw new Error("Object exceeds the permitted size");
      chunks.push(Buffer.from(chunk));
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally { stream.destroy?.(); }
}

class LocalObjectStore implements ObjectStore {
  private root = resolve(join(process.cwd(), "var", "objects"));

  async put(key: string, data: Uint8Array) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data)
  }

  async get(key: string, maximum?: number) {
    return boundedBytes(createReadStream(this.path(key)),maximum);
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
    if (!process.env.OBJECT_STORAGE_REGION?.trim()) throw new Error("OBJECT_STORAGE_REGION is required for the S3 object store");
    if (Boolean(process.env.OBJECT_STORE_ACCESS_KEY_ID) !== Boolean(process.env.OBJECT_STORE_SECRET_ACCESS_KEY)) {
      throw new Error("Object store access key and secret must be configured together")
    }
    if (process.env.OBJECT_STORAGE_ENDPOINT && !process.env.OBJECT_STORE_ACCESS_KEY_ID) {
      throw new Error("Explicit object store credentials are required for a custom S3 endpoint")
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

  async get(key: string, maximum?: number) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectStorageKey(key) }));
    if (!result.Body) throw new Error("Object body is empty");
    return boundedBytes(result.Body as AsyncIterable<Uint8Array> & {destroy?:()=>void},maximum);
  }
}

let instance: ObjectStore | undefined;

export function objectStorageDriver(): "local" | "s3" {
  const driver = process.env.OBJECT_STORAGE_DRIVER?.trim() || "local";
  if (driver !== "local" && driver !== "s3") throw new Error("OBJECT_STORAGE_DRIVER must be local or s3");
  if (driver === "local" && process.env.NODE_ENV === "production") {
    throw new Error("Production requires shared S3 object storage; local storage is not supported");
  }
  return driver;
}

export function objectStore() {
  const driver = objectStorageDriver();
  instance ??= driver === "s3" ? new S3ObjectStore() : new LocalObjectStore();
  return instance
}
