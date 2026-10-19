"use client";

import { Typography } from "@arco-design/web-react";
import Image from "next/image";

export function EnvoyLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span aria-label="Envoy" className="envoy-logo">
      <Image
        alt=""
        aria-hidden="true"
        className="envoy-mark"
        height={30}
        src="/icon.svg"
        width={30}
      />
      {!compact && <Typography.Text bold>Envoy</Typography.Text>}
    </span>
  );
}
