"use client";

import Link from "next/link";
import { Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { StatusPill } from "@/components/status-pill";
import type { DeliveryStatus, EmailRecord } from "@/lib/types";

const statusOptions: Array<{ value: "all" | DeliveryStatus; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "delivered", label: "Delivered" },
  { value: "accepted", label: "Accepted" },
  { value: "submitting", label: "Submitting" },
  { value: "queued", label: "Queued" },
  { value: "deferred", label: "Deferred" },
  { value: "unknown", label: "Unknown" },
  { value: "bounced", label: "Bounced" },
  { value: "failed", label: "Failed" },
  { value: "suppressed", label: "Suppressed" },
];

export function EmailTable({
                             records,
                             compact = false,
                           }: {
  records: EmailRecord[];
  compact?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | DeliveryStatus>("all");

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return records.filter((email) => {
      const statusMatches = status === "all" || email.status === status;
      const queryMatches =
        !normalized ||
        email.recipient.toLowerCase().includes(normalized) ||
        email.subject.toLowerCase().includes(normalized) ||
        email.product.toLowerCase().includes(normalized);
      return statusMatches && queryMatches;
    });
  }, [query, records, status]);

  return (
    <div>
      {!compact && (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row">
          <label className="relative min-w-0 flex-1 sm:max-w-sm">
            <span className="sr-only">Search messages</span>
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-2.5 text-zinc-600"
              aria-hidden="true"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search recipient, subject, or product"
              className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 pl-9 pr-3 text-sm text-zinc-200 outline-none transition placeholder:text-zinc-700 focus:border-zinc-600"
            />
          </label>
          <label className="relative">
            <span className="sr-only">Filter by status</span>
            <SlidersHorizontal
              size={14}
              className="pointer-events-none absolute left-3 top-2.5 text-zinc-600"
              aria-hidden="true"
            />
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as "all" | DeliveryStatus)}
              className="h-9 min-w-36 appearance-none rounded-md border border-zinc-800 bg-zinc-950 pl-9 pr-8 text-sm text-zinc-300 outline-none transition focus:border-zinc-600"
            >
              {statusOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-zinc-800/90 bg-[#090909]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead>
            <tr className="border-b border-zinc-800/90 text-[11px] text-zinc-600">
              <th className="px-4 py-3 font-medium">Recipient</th>
              <th className="px-4 py-3 font-medium">Subject</th>
              <th className="px-4 py-3 font-medium">Product</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Time</th>
            </tr>
            </thead>
            <tbody>
            {filtered.slice(0, compact ? 5 : undefined).map((email) => (
              <tr
                key={email.id}
                className="group border-b border-zinc-900 text-sm last:border-0 hover:bg-zinc-900/40"
              >
                <td className="px-4 py-3.5">
                  <Link href={`/emails/${email.id}`} className="block">
                      <span className="font-medium text-zinc-300 transition group-hover:text-white">
                        {email.recipient}
                      </span>
                  </Link>
                </td>
                <td className="max-w-xs px-4 py-3.5">
                  <Link href={`/emails/${email.id}`} className="block truncate text-zinc-400 group-hover:text-zinc-200">
                    {email.subject}
                  </Link>
                </td>
                <td className="px-4 py-3.5 text-zinc-500">{email.product}</td>
                <td className="px-4 py-3.5">
                  <StatusPill status={email.status}/>
                </td>
                <td className="px-4 py-3.5 text-right text-xs text-zinc-600">
                  {email.relativeTime}
                </td>
              </tr>
            ))}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <div className="px-6 py-14 text-center text-sm text-zinc-600">
            No messages match the current filters.
          </div>
        )}
      </div>
    </div>
  );
}
