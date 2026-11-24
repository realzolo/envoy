import "server-only";
import { ReaderError } from "@/modules/mail-reader/public";

export const READER_HEADERS = {
  "cache-control": "private, no-store, no-transform",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "access-control-allow-origin": "*"
};

export function readerOrigin(request: Request) {
  const configured = process.env.ENVOY_PUBLIC_URL;
  if (!configured && process.env.NODE_ENV === "production") throw new Error("ENVOY_PUBLIC_URL is required for the hosted mail reader");
  const url = new URL(configured ?? request.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search || configured && url.pathname !== "/" || process.env.NODE_ENV === "production" && url.protocol !== "https:") throw new Error("ENVOY_PUBLIC_URL must be an HTTPS origin");
  return url.origin;
}

export function readerProblem(error: unknown) {
  if (error instanceof ReaderError) return Response.json({ code: error.code }, {
    status: error.status,
    headers: READER_HEADERS
  });
  throw error;
}
