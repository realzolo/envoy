import { z } from "zod";

const identifier = z.string().trim().min(1).max(160);

export const domainPermissionSchema = z.object({
  mode: z.enum(["none", "selected", "all"]),
  domainIds: z.array(identifier).default([]),
}).strict().superRefine((permission, context) => {
  if (permission.mode === "selected" && permission.domainIds.length === 0) {
    context.addIssue({ code: "custom", path: ["domainIds"], message: "Select at least one domain" });
  }
  if (permission.mode !== "selected" && permission.domainIds.length > 0) {
    context.addIssue({ code: "custom", path: ["domainIds"], message: "Only selected-domain mode accepts domain IDs" });
  }
  if (new Set(permission.domainIds).size !== permission.domainIds.length) {
    context.addIssue({ code: "custom", path: ["domainIds"], message: "Duplicate domain" });
  }
});

export const serviceConfigurationSchema = z.object({
  productId: identifier,
  serviceName: z.string().trim().min(2).max(120),
  sending: domainPermissionSchema,
  receiving: domainPermissionSchema,
  callbackUrl: z.union([z.literal(""), z.string().trim().url().max(2048)]).default(""),
  suppressionManagement: z.boolean().default(false),
}).strict();

export type DomainPermission = z.infer<typeof domainPermissionSchema>;
export type ServiceConfiguration = z.infer<typeof serviceConfigurationSchema>;
