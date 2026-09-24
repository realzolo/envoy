import { afterEach, describe, expect, it, vi } from "vitest";
import { scanAttachment } from "@/modules/inbound/service";

describe("inbound attachment scanning", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "", "   "])("skips scanning in production when CLAMAV_HOST is %s", async host => {
    vi.stubEnv("NODE_ENV", "production");
    if (host === undefined) delete process.env.CLAMAV_HOST;
    else vi.stubEnv("CLAMAV_HOST", host);

    await expect(scanAttachment(new Uint8Array([1, 2, 3]))).resolves.toBe("skipped");
  });
});
