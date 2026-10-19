import { z } from "zod";
export const identifierSchema = z.string().trim().min(1).max(160);
const categorySchema = z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, "category must be a stable lowercase key");
const optionalIdentifierSchema = z.preprocess(value => typeof value === "string" && value.trim() === "" ? undefined : value, identifierSchema.optional());
const routingTargetSchema = z.object({
    accountId: identifierSchema,
    identityId: identifierSchema,
    priority: z.coerce.number().int().min(0).max(1000000).default(100),
    weight: z.coerce.number().int().min(1).max(1000000).default(100),
    rateLimit: z.coerce.number().int().min(1).max(1000000).default(1000),
}).strict();
export const routingPolicyInputSchema = z.object({
    name: z.string().trim().min(2).max(120),
    productId: optionalIdentifierSchema,
    serviceId: optionalIdentifierSchema,
    domainId: identifierSchema,
    category: z.preprocess(value => typeof value === "string" && value.trim() === "" ? undefined : value, categorySchema.optional()),
    priority: z.coerce.number().int().min(0).max(1000000).default(100),
    targets: z.array(routingTargetSchema).min(1, "At least one routing target is required").max(20),
}).strict().superRefine((input, context) => {
    const identities = new Set<string>();
    input.targets.forEach((target, index) => {
        if (identities.has(target.identityId))
            context.addIssue({
                code: "custom",
                path: ["targets", index, "identityId"],
                message: "An identity can appear only once in a routing policy",
            });
        identities.add(target.identityId);
    });
});
