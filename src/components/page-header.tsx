"use client";

import { PageHeader as ArcoPageHeader, Space, Typography } from "@arco-design/web-react";
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
      className="page-header arco-page-header-wrap"
      backIcon={backIcon}
      extra={actions ? <Space size="small" wrap>{actions}</Space> : undefined}
      onBack={onBack}
      subTitle={description}
      title={(
        <Typography.Title className="page-header__title" heading={4}>
          {title}
        </Typography.Title>
      )}
    />
  );
}
