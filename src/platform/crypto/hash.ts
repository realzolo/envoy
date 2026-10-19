import { createHash } from "node:crypto";

export function hashApiKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
