"use client";

import { Button,Space,Typography } from "@arco-design/web-react";
import { IconArrowLeft } from "@arco-design/web-react/icon";
import type { ReactNode } from "react";

export function PageHeader({title, description, actions, backIcon = false, onBack}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  backIcon?: boolean;
  onBack?: () => void;
}) {
  return (
    <header className="page-header">
      <div className="page-header__main">
        {backIcon && <Button aria-label="Go back" icon={<IconArrowLeft />} onClick={onBack} type="text" />}
        <div className="page-header__copy">
          <Typography.Title className="page-header__title" heading={4}>{title}</Typography.Title>
          {description && <Typography.Paragraph className="page-header__description">{description}</Typography.Paragraph>}
        </div>
      </div>
      {actions && <Space className="page-header__actions" size="small" wrap>{actions}</Space>}
    </header>
  );
}
