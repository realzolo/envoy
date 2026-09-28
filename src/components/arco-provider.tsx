"use client";

import "@arco-design/web-react/es/_util/react-19-adapter";
import { ConfigProvider } from "@arco-design/web-react";
import enUS from "@arco-design/web-react/es/locale/en-US";
import type { ReactNode } from "react";

export function ArcoProvider({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider locale={enUS} size="default">
      {children}
    </ConfigProvider>
  );
}
