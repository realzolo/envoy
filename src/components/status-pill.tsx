import type { DeliveryStatus } from "@/lib/types";

const statusStyles: Record<DeliveryStatus, string> = {
  delivered: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
  accepted: "border-sky-500/20 bg-sky-500/10 text-sky-400",
  submitting: "border-sky-500/20 bg-sky-500/10 text-sky-400",
  queued: "border-zinc-700 bg-zinc-800/70 text-zinc-300",
  deferred: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  unknown: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  bounced: "border-red-500/20 bg-red-500/10 text-red-400",
  failed: "border-red-500/20 bg-red-500/10 text-red-400",
  canceled: "border-zinc-700 bg-zinc-900 text-zinc-500",
  suppressed: "border-violet-500/20 bg-violet-500/10 text-violet-300",
};

const statusLabels: Record<DeliveryStatus, string> = {
  delivered: "Delivered",
  accepted: "Accepted",
  submitting: "Submitting",
  queued: "Queued",
  deferred: "Deferred",
  unknown: "Unknown",
  bounced: "Bounced",
  failed: "Failed",
  canceled: "Canceled",
  suppressed: "Suppressed",
};

export function StatusPill({ status }: { status: DeliveryStatus }) {
  return (
    <span
      className={`inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs font-medium ${statusStyles[status]}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true"/>
      {statusLabels[status]}
    </span>
  );
}
