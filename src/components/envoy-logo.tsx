"use client";

import { Avatar, Typography } from "@arco-design/web-react";
import { IconBranch } from "@arco-design/web-react/icon";

export function EnvoyLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span aria-label="Envoy" className="envoy-logo">
      <Avatar className="envoy-mark" shape="square" size={30}>
        <IconBranch aria-hidden="true" />
      </Avatar>
      {!compact && <Typography.Text bold>Envoy</Typography.Text>}
    </span>
  );
}
