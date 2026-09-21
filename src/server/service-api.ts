import { decodeCursor } from "@/modules/core/message/service";

export function apiProblem(title: string, status: number, detail?: string, errors?: unknown) {
  return Response.json({ title, status, detail, errors }, {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

export function pagination(request: Request) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const rawCursor = url.searchParams.get("cursor");
  const cursor = decodeCursor(rawCursor);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (rawCursor && !cursor)) return null;
  return { url, limit, cursor };
}
