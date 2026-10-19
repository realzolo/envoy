"use client";
import { ActionButton } from "@/components/admin-console-shared";
import { IconExclamationCircle,IconRotateLeft } from "@arco-design/web-react/icon";
export function RetryDeliveryButton({ id, unknown }: { id: string; unknown: boolean }) {
  return (
    <ActionButton
      body={{method:"POST",path:`/api/admin/deliveries/${encodeURIComponent(String(id))}/retries`,payload:{id, acknowledgeDuplicateRisk: unknown}}}
      confirmOkText={unknown ? "Accept risk and retry" : "Retry"}
      confirmText={unknown ? "The provider outcome is unknown. Retrying may send a duplicate. Accept the risk and continue?" : "Retry this delivery?"}
      confirmTitle={unknown ? "Retry with duplicate risk?" : "Retry delivery?"}
    >
      {unknown ? <IconExclamationCircle /> : <IconRotateLeft />}Manual retry
    </ActionButton>
  );
}