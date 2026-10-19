import { z } from "zod";

const identifier = z.string().trim().min(1).max(160);

export const serviceDomainBindingSchema = z.object({
  domainId: identifier,
  receive: z.boolean(),
  outboundIdentityId: identifier.nullable(),
}).strict().refine(binding => binding.receive || binding.outboundIdentityId !== null, {
  message: "Choose receiving or a sending provider",
});

export const serviceConfigurationSchema = z.object({
  serviceName: z.string().trim().min(2).max(120),
  domains: z.array(serviceDomainBindingSchema).superRefine((bindings, context) => {
    const seen = new Set<string>();
    bindings.forEach((binding, index) => {
      if (seen.has(binding.domainId)) context.addIssue({ code: "custom", path: [index, "domainId"], message: "Domain is already bound" });
      seen.add(binding.domainId);
    });
  }),
  callbackUrl: z.union([z.literal(""), z.string().trim().url().max(2048)]).default(""),
  suppressionManagement: z.boolean().default(false),
}).strict();

export type ServiceDomainBinding = z.infer<typeof serviceDomainBindingSchema>;
export type ServiceConfiguration = z.infer<typeof serviceConfigurationSchema>;
