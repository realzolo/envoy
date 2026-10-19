import { z } from "zod";

const optionalId = z.preprocess(v => v === "" || v == null ? undefined : v, z.string().trim().min(1).max(160).optional());
const optionalDate = z.preprocess(v => v === "" || v == null ? undefined : v, z.string().datetime({ offset: true }).optional());
export const adminSuppressionSchema = z.object({
  email: z.string().trim().email().max(320), scope: z.enum(["global", "product", "list"]),
  productId: optionalId, listId: optionalId, reason: z.string().trim().min(1).max(240), expiresAt: optionalDate,
}).strict().superRefine((v, ctx) => {
  if (v.scope === "global" && (v.productId || v.listId)) ctx.addIssue({ code: "custom", path: ["scope"], message: "Global suppressions cannot target a product or list" });
  if (v.scope === "product" && (!v.productId || v.listId)) ctx.addIssue({ code: "custom", path: ["scope"], message: "Product suppressions require a product and cannot target a list" });
  if (v.scope === "list" && (!v.productId || !v.listId)) ctx.addIssue({ code: "custom", path: ["scope"], message: "List suppressions require both a product and list ID" });
});
export type SuppressionInput = { productId: string; email: string; scope: "product" | "list"; listId?: string; reason: string; expiresAt?: string };
export type AdminSuppressionInput = Omit<SuppressionInput, "productId" | "scope"> & { productId?: string; scope: "global" | "product" | "list" };
export type SuppressionDto = { id: string; scope: string; listId: string | null; email: string; reason: string; source: string; expiresAt: string | null; createdAt: string };
