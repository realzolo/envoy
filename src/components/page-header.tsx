"use client";

import { PageHeader as ArcoPageHeader, Space } from "@arco-design/web-react";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
  backIcon = false,
  onBack,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  backIcon?: boolean;
  onBack?: () => void;
}) {
  return (
    <ArcoPageHeader
      backIcon={backIcon}
      extra={actions ? <Space size="small" wrap>{actions}</Space> : undefined}
      onBack={onBack}
      subTitle={description}
      title={title}
    />
  );
}
