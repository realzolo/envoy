import { describe, expect, it } from "vitest";
import { adminData } from "@/modules/admin/queries";

describe("admin data queries", () => {
  it("returns callback ownership fields used by inbound routing", async () => {
    const data = await adminData("webhooks");

    expect(data.callbacks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "cb_atlas_local",
        service_id: "svc_atlas_auth",
        product_id: "prd_atlas"
      })
    ]));
  });
});
