import { afterEach, describe, expect, it, vi } from "vitest";
import { objectStorageDriver } from "@/platform/storage/object-store";

describe("object storage driver selection", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("permits local files for development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OBJECT_STORAGE_DRIVER", "local");
    expect(objectStorageDriver()).toBe("local");
  });

  it("requires shared storage in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OBJECT_STORAGE_DRIVER", "local");
    expect(() => objectStorageDriver()).toThrow("Production requires shared S3 object storage");
    vi.stubEnv("OBJECT_STORAGE_DRIVER", "s3");
    expect(objectStorageDriver()).toBe("s3");
  });

  it("rejects a misspelled driver instead of silently using local files", () => {
    vi.stubEnv("OBJECT_STORAGE_DRIVER", "s33");
    expect(() => objectStorageDriver()).toThrow("OBJECT_STORAGE_DRIVER must be local or s3");
  });
});
