import type { DeliveryStatus } from "@/lib/types";

export type MessageFilters = { q: string; status: "all" | DeliveryStatus; cursor?: string };
const statuses = new Set(["all", "queued", "submitting", "accepted", "deferred", "delivered", "bounced", "failed", "unknown", "canceled", "suppressed"]);

export function messageFilters(params: URLSearchParams): MessageFilters {
  const status = params.get("status") ?? "all";
  return {
    q: (params.get("q") ?? "").trim().slice(0, 200),
    status: statuses.has(status) ? status as MessageFilters["status"] : "all",
    cursor: params.get("cursor")?.slice(0, 500) || undefined
  }
}

export function messageFilterQuery(filters: MessageFilters, includeCursor = false) {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.status !== "all") params.set("status", filters.status);
  if (includeCursor && filters.cursor) params.set("cursor", filters.cursor);
  return params.toString()
}
