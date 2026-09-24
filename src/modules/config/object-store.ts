import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface ObjectStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;

  get(key: string): Promise<Uint8Array>
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
    forcePathStyle: Boolean(process.env.OBJECT_STORAGE_ENDPOINT)
  });
  private bucket = process.env.OBJECT_STORAGE_BUCKET ?? "";

  constructor() {
    if (!this.bucket) throw new Error("OBJECT_STORAGE_BUCKET is required for the S3 object store")
  }

  async put(key: string, data: Uint8Array, contentType: string) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectStorageKey(key),
      Body: data,
      ContentType: contentType,
      ServerSideEncryption: "AES256"
    }))
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
