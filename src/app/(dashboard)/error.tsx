"use client";

import { Button, Result, Space, Typography } from "@arco-design/web-react";
import { IconHome, IconRefresh } from "@arco-design/web-react/icon";
import { useEffect } from "react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Result
      status="error"
      title="Unable to load this page"
      subTitle="The request could not be completed. Check service health and try again."
      extra={(
        <Space direction="vertical" size="medium" align="center">
          <Space wrap>
            <Button icon={<IconRefresh />} onClick={reset} type="primary">Try again</Button>
            <Button href="/" icon={<IconHome />}>Back to overview</Button>
          </Space>
          {error.digest && (
            <Typography.Text code type="secondary">Reference: {error.digest}</Typography.Text>
          )}
        </Space>
      )}
    />
  );
}
