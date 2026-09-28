"use client";

import { Button, Tooltip } from "@arco-design/web-react";
import { IconPoweroff } from "@arco-design/web-react/icon";
import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();

  return (
    <Tooltip content="Sign out">
      <Button
        aria-label="Sign out"
        icon={<IconPoweroff aria-hidden="true" />}
        onClick={async () => {
          await fetch("/api/admin/session", { method: "DELETE" });
          router.push("/login");
          router.refresh();
        }}
        shape="circle"
        type="text"
      />
    </Tooltip>
  );
}
