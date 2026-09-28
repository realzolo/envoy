"use client";

import { Tag } from "@arco-design/web-react";
import type { DeliveryStatus } from "@/lib/types";

const statusMeta: Record<DeliveryStatus, { color: string; label: string }> = {
  delivered: { color: "green", label: "Delivered" },
  accepted: { color: "arcoblue", label: "Accepted" },
  submitting: { color: "arcoblue", label: "Submitting" },
  queued: { color: "gray", label: "Queued" },
  deferred: { color: "gold", label: "Deferred" },
  unknown: { color: "gold", label: "Unknown" },
  bounced: { color: "red", label: "Bounced" },
  failed: { color: "red", label: "Failed" },
  canceled: { color: "gray", label: "Canceled" },
  suppressed: { color: "purple", label: "Suppressed" },
};

export function StatusPill({ status }: { status: DeliveryStatus }) {
  const { color, label } = statusMeta[status];

  return (
    <Tag
      bordered={false}
      color={color}
      size="small"
    >
      {label}
    </Tag>
  );
}
