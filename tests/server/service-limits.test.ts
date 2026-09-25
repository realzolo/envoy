import { describe, expect, it } from "vitest";
import { GET as getCapabilities } from "@/app/api/v1/capabilities/route";
import { authenticateService } from "@/server/auth";
import { SERVICE_REQUESTS_PER_MINUTE } from "@/server/service-limits";

describe("service request limits", () => {
  it("uses the fixed system limit for authenticated services and capabilities", async () => {
    const request = new Request("http://envoy.test/api/v1/capabilities", {
      headers: { authorization: "Bearer envoy_test_key" }
    });

    const identity = await authenticateService(request);
    const response = await getCapabilities(request);

    expect(identity?.rateLimitPerMinute).toBe(SERVICE_REQUESTS_PER_MINUTE);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      limits: { requestsPerMinute: SERVICE_REQUESTS_PER_MINUTE }
    });
  });
});
