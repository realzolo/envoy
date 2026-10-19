import { createHash } from "node:crypto";
export const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
