import type { WebhookVerification } from "@/integrations/providers/contracts";
export function serializeVerification(verification: WebhookVerification) {
    return JSON.parse(JSON.stringify(verification, (_key, value) => {
        if (value instanceof Uint8Array)
            return { __envoyBytes: Buffer.from(value).toString("base64") };
        if (value && value.type === "Buffer" && Array.isArray(value.data))
            return { __envoyBytes: Buffer.from(value.data).toString("base64") };
        return value;
    }));
}
export function restoreVerification(value: unknown): WebhookVerification {
    return JSON.parse(JSON.stringify(value), (_key, item) => item && typeof item === "object" && typeof item.__envoyBytes === "string" ? new Uint8Array(Buffer.from(item.__envoyBytes, "base64")) : item);
}
